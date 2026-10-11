/// <reference lib="webworker" />
// Evaluates the engine's inference slots with onnxruntime-web.
//
// Started by engine.worker.ts with the engine's shared WebAssembly.Memory.
// A WebGPU worker serves a group of slots, merging simultaneous requests into
// one fixed-size call that is replayed from a captured graph; WASM workers each
// serve one slot on a single CPU thread.

import { mapOutputNames, readRegistry, serveSlots, type NetworkOutputs, type NetworkRunner } from "./inferenceCore";
import type { InferenceInit, InferenceMessage } from "./protocol";

type Ort = typeof import("onnxruntime-web");
type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;

const INPUT_SHAPE = [74, 8, 8];

async function loadOrt(backend: InferenceInit["backend"]): Promise<Ort> {
  // The default bundle carries the JSEP WebGPU backend, which measured faster
  // than the native WebGPU EP for this network.
  const ort = (backend === "webgpu"
    ? await import("onnxruntime-web")
    : await import("onnxruntime-web/wasm")) as unknown as Ort;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
  // Production builds load onnxruntime's WebAssembly (14-28 MB) from jsDelivr
  // rather than the site's own host; see vite.config.ts.
  if (import.meta.env.PROD) ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${__ORT_VERSION__}/dist/`;
  return ort;
}

function outputsFrom(names: ReturnType<typeof mapOutputNames>, get: (name: string) => Float32Array): NetworkOutputs {
  return {
    value: get(names.value),
    policyA: get(names.policyA),
    policyB: get(names.policyB),
    wdl: get(names.wdl),
    movesLeft: get(names.movesLeft),
  };
}

/** Plain session: CPU, or WebGPU without graph capture. */
async function plainRunner(ort: Ort, model: Uint8Array, ep: string): Promise<NetworkRunner> {
  const session = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: "all" });
  const names = mapOutputNames(session.outputNames);
  const inputName = session.inputNames[0];
  return async (input, batch) => {
    const out = await session.run({ [inputName]: new ort.Tensor("float32", input, [batch, ...INPUT_SHAPE]) });
    return outputsFrom(names, (name) => out[name].data as Float32Array);
  };
}

/**
 * WebGPU with a captured graph: every call has `capacity` rows (shorter
 * batches are zero-padded), which lets onnxruntime replay recorded command
 * buffers instead of re-dispatching each kernel. Network cost is almost flat
 * in batch size on a GPU, so the padding is nearly free.
 */
async function capturedRunner(ort: Ort, model: Uint8Array, capacity: number, inputValues: number): Promise<NetworkRunner> {
  const session: Session = await ort.InferenceSession.create(model, {
    executionProviders: ["webgpu"],
    graphOptimizationLevel: "all",
    freeDimensionOverrides: { batch: capacity },
    enableGraphCapture: true,
    preferredOutputLocation: "gpu-buffer",
  });
  const device = (await ort.env.webgpu.device) as GPUDevice;
  const buffer = device.createBuffer({
    size: capacity * inputValues * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const input = ort.Tensor.fromGpuBuffer(buffer, { dataType: "float32", dims: [capacity, ...INPUT_SHAPE] });
  const padded = new Float32Array(capacity * inputValues);
  const names = mapOutputNames(session.outputNames);
  const inputName = session.inputNames[0];
  return async (data, batch) => {
    if (batch > capacity) throw new Error(`batch ${batch} exceeds capacity ${capacity}`);
    padded.set(data);
    if (data.length < padded.length) padded.fill(0, data.length);
    device.queue.writeBuffer(buffer, 0, padded);
    const out = await session.run({ [inputName]: input });
    const arrays = await Promise.all(session.outputNames.map(async (name) => [name, (await out[name].getData(true)) as Float32Array] as const));
    const byName = new Map(arrays);
    return outputsFrom(names, (name) => byName.get(name)!);
  };
}

let stopped = false;

self.onmessage = async (event: MessageEvent<InferenceInit | "stop">) => {
  if (event.data === "stop") {
    stopped = true;
    return;
  }
  const init = event.data;
  const post = (message: InferenceMessage) => self.postMessage(message);
  try {
    const ort = await loadOrt(init.backend);
    const registry = readRegistry(init.memory, init.registryPtr);
    const slots = registry.slots.filter((slot) => init.slots.includes(slot.index));
    const capacity = slots.reduce((sum, slot) => sum + slot.batch, 0) || 1;

    let run: NetworkRunner;
    if (init.backend === "webgpu") {
      try {
        run = await capturedRunner(ort, init.model, capacity, registry.inputValues);
      } catch (error) {
        console.warn("graph capture unavailable, using plain WebGPU", error);
        run = await plainRunner(ort, init.model, "webgpu");
      }
    } else {
      run = await plainRunner(ort, init.model, "wasm");
    }

    // Warm up so the first real request does not pay for shader compilation.
    const warmStart = performance.now();
    await run(new Float32Array(capacity * registry.inputValues), capacity);
    await run(new Float32Array(capacity * registry.inputValues), capacity);
    post({ type: "ready", slots: slots.map((s) => s.index), warmupMs: performance.now() - warmStart });

    let positions = 0;
    let calls = 0;
    let busy = 0;
    let lastReport = performance.now();
    await serveSlots({
      memory: init.memory,
      registry,
      slots,
      run,
      mergeBatches: init.backend === "webgpu",
      shouldStop: () => stopped,
      onBatch: (n, ms) => {
        positions += n;
        calls++;
        busy += ms;
        const now = performance.now();
        if (now - lastReport > 1000) {
          post({ type: "stats", positions, calls, busyMs: busy, windowMs: now - lastReport });
          positions = 0;
          calls = 0;
          busy = 0;
          lastReport = now;
        }
      },
    });
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
