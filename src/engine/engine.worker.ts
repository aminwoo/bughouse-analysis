/// <reference lib="webworker" />
// Hosts the hivemind WebAssembly module and its inference workers.
//
// The module is built with PROXY_TO_PTHREAD, so its main() runs on a pthread
// and this worker's event loop stays free: it forwards UCI commands in and
// output lines out, and spawns the module's pthread workers on demand.

import type { EngineConfig, EngineInfo, FromEngine, InferenceBackend, InferenceMessage, ToEngine } from "./protocol";
import { loadNetwork } from "./network";
import { splitsToSlices } from "./onnxRewrite";

interface HivemindModule {
  ccall: (name: string, ret: null, types: string[], args: unknown[]) => void;
  wasmMemory: WebAssembly.Memory;
  _hm_inference_registry: () => number;
}

type CreateHivemind = (options: Record<string, unknown>) => Promise<HivemindModule>;

const post = (message: FromEngine) => self.postMessage(message);

let module: HivemindModule | null = null;
const inferenceWorkers: Worker[] = [];
let pendingCommands: string[] = [];

async function detectBackend(config: EngineConfig): Promise<{ backend: InferenceBackend; gpu?: string; f16?: boolean }> {
  if (config.backend === "wasm") return { backend: "wasm" };
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu) {
    try {
      // Some browsers (headless Chrome) answer the hint with no adapter at all.
      const adapter = (await gpu.requestAdapter({ powerPreference: "high-performance" })) ?? (await gpu.requestAdapter());
      if (adapter) {
        const info = adapter.info;
        const name = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ");
        return { backend: "webgpu", gpu: name || "WebGPU", f16: adapter.features.has("shader-f16") };
      }
    } catch {
      // Fall through to the CPU.
    }
  }
  if (config.backend === "webgpu") post({ type: "status", text: "WebGPU unavailable, using the CPU" });
  return { backend: "wasm" };
}

async function fetchWithProgress(url: string, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`failed to fetch ${url}: ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) post({ type: "status", text: label, progress: received / total });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function init(config: EngineConfig, base: string) {
  if (!self.crossOriginIsolated) {
    throw new Error("This page is not cross-origin isolated, so the engine cannot use threads.");
  }
  const { backend, gpu, f16 } = await detectBackend(config);
  const cores = navigator.hardwareConcurrency || 4;
  // CPU: one single-threaded inference worker per logical core but one, which
  // measured faster than leaving the hyperthreads idle.
  const cpuWorkers = config.threads > 0 ? config.threads : Math.max(1, Math.min(16, cores - 1));
  // WebGPU: a call costs about the same for 16 positions as for 64, so many
  // search slots (each with its own batch) keep the GPU calls full. Their
  // threads mostly wait on the GPU, so they scale with the cores loosely.
  const gpuSlots = config.gpuSlots && config.gpuSlots > 0 ? config.gpuSlots : Math.max(16, Math.min(48, cores * 4));
  const slots = backend === "webgpu" ? gpuSlots : cpuWorkers;
  const batch = config.batchSize && config.batchSize > 0 ? config.batchSize : 8;

  post({ type: "status", text: "Loading network" });
  const network = await loadNetwork(config.network, base, fetchWithProgress);
  // GPUs with FP16 shaders run the published FP16 network as is, apart from
  // its Split nodes, which onnxruntime's WebGPU backend lacks in FP16.
  const useFp16 = backend === "webgpu" && !!f16 && config.fp16 !== false && !!network.fp16;
  const model = useFp16 ? splitsToSlices(network.fp16!).model : network.model;

  post({ type: "status", text: "Starting engine" });
  const engineUrl = new URL(`${base}engine/hivemind.js`, self.location.origin).href;
  const { default: createHivemind } = (await import(/* @vite-ignore */ engineUrl)) as { default: CreateHivemind };
  let resolveReady: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => (resolveReady = resolve));
  module = await createHivemind({
    arguments: ["--engines", String(slots), "--batch-size", String(batch), "--model", "/model.onnx"],
    // One thread per search slot, plus the UCI loop, search driver and
    // garbage collector, Fairy-Stockfish's main thread and four probe
    // workers, and the three threads that run beside every search (winning
    // and losing root scans, mate probe).
    pthreadPoolSize: slots + 12,
    locateFile: (path: string) => new URL(`${base}engine/${path}`, self.location.origin).href,
    mainScriptUrlOrBlob: engineUrl,
    print: (line: string) => {
      if (line.includes("hivemind web ready")) resolveReady(true);
      else if (line.includes("failed to initialize")) resolveReady(false);
      post({ type: "line", line });
    },
    printErr: (line: string) => console.warn("[hivemind]", line),
    preRun: [(m: { FS: { writeFile: (path: string, data: string) => void } }) => m.FS.writeFile("/model.onnx", "web")],
  });
  if (!(await ready)) throw new Error("engine failed to initialize");

  post({ type: "status", text: backend === "webgpu" ? "Compiling network for the GPU" : "Loading network" });
  const registryPtr = module._hm_inference_registry();
  const gpuWorkers = Math.max(1, Math.min(slots, config.gpuWorkers && config.gpuWorkers > 0 ? config.gpuWorkers : slots >= 32 ? 3 : 2));
  const groups =
    backend === "webgpu"
      ? Array.from({ length: gpuWorkers }, (_, w) => Array.from({ length: slots }, (_, i) => i).filter((i) => i % gpuWorkers === w))
      : Array.from({ length: slots }, (_, i) => [i]);
  let positions = 0;
  let calls = 0;
  let busyMs = 0;
  let readMs = 0;
  let windowMs = 0;
  let fp16 = useFp16;
  await Promise.all(
    groups.map(
      (group) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(new URL("./inference.worker.ts", import.meta.url), { type: "module" });
          inferenceWorkers.push(worker);
          worker.onmessage = (event: MessageEvent<InferenceMessage>) => {
            const message = event.data;
            if (message.type === "ready") {
              fp16 &&= message.fp16;
              resolve();
            }
            else if (message.type === "error") reject(new Error(message.message));
            else if (message.type === "stats") {
              positions += message.positions;
              calls += message.calls;
              busyMs += message.busyMs;
              readMs += message.readMs;
              windowMs = Math.max(windowMs, message.windowMs);
            }
          };
          worker.onerror = (event) => reject(new Error(event.message || "inference worker failed"));
          worker.postMessage({ memory: module!.wasmMemory, registryPtr, slots: group, backend, model: model.slice(), fp16: useFp16 });
        }),
    ),
  );
  setInterval(() => {
    if (windowMs > 0) {
      post({
        type: "stats",
        nps: (positions * 1000) / windowMs,
        busy: busyMs / (windowMs * groups.length),
        batchAvg: calls ? positions / calls : 0,
        callMs: calls ? busyMs / calls : 0,
        readMs: calls ? readMs / calls : 0,
      });
    }
    positions = 0;
    calls = 0;
    busyMs = 0;
    readMs = 0;
    windowMs = 0;
  }, 1000);

  const info: EngineInfo = { backend, slots, batch, gpu, fp16, network: network.info };
  post({ type: "ready", info });
  for (const cmd of pendingCommands) send(cmd);
  pendingCommands = [];
}

function send(cmd: string) {
  if (!module) {
    pendingCommands.push(cmd);
    return;
  }
  module.ccall("hm_command", null, ["string"], [cmd]);
}

self.onmessage = (event: MessageEvent<ToEngine>) => {
  const message = event.data;
  if (message.type === "init") {
    init(message.config, message.base).catch((error: unknown) => {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  } else if (message.type === "cmd") {
    send(message.cmd);
  }
};
