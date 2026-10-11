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
/** Time spent waiting for WebGPU readbacks, reported with the stats. */
let readMs = 0;

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

/** Batch sizes to capture for `capacity` rows: halvings down to one slot's batch. */
export function captureSizes(capacity: number, slotBatch: number): number[] {
  const sizes = [capacity];
  while (sizes[0] / 2 >= slotBatch && sizes[0] % 2 === 0) sizes.unshift(sizes[0] / 2);
  return sizes;
}

/**
 * WebGPU with captured graphs: onnxruntime replays recorded command buffers
 * instead of re-dispatching each kernel, which halves the cost of a call, but a
 * captured graph has a fixed batch. Several sizes are captured and each call
 * runs on the smallest that fits, since GPU time grows with the rows computed.
 * Only the rows in use cross the bus either way.
 */
async function capturedRunner(ort: Ort, model: Uint8Array, capacity: number, slotBatch: number, inputValues: number): Promise<NetworkRunner> {
  const sizes = captureSizes(capacity, slotBatch);
  const sessions: { size: number; session: Session }[] = [];
  for (const size of sizes) {
    sessions.push({
      size,
      session: await ort.InferenceSession.create(model, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
        freeDimensionOverrides: { batch: size },
        enableGraphCapture: true,
        preferredOutputLocation: "gpu-buffer",
      }),
    });
  }
  const device = (await ort.env.webgpu.device) as GPUDevice;
  // One input buffer for all sizes; each session reads its first rows.
  const buffer = device.createBuffer({
    size: capacity * inputValues * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const inputs = sessions.map(({ size }) => ort.Tensor.fromGpuBuffer(buffer, { dataType: "float32", dims: [size, ...INPUT_SHAPE] }));
  const outputNames = sessions[0].session.outputNames;
  const names = mapOutputNames(outputNames);
  const inputName = sessions[0].session.inputNames[0];
  // Values per position of each output, and a staging buffer that holds all
  // of them for a full batch; set up on the first run.
  let widths: number[] | null = null;
  let staging: GPUBuffer | null = null;
  return async (data, batch) => {
    const index = sessions.findIndex(({ size }) => size >= batch);
    if (index < 0) throw new Error(`batch ${batch} exceeds capacity ${capacity}`);
    const { session } = sessions[index];
    // Rows past `batch` keep an earlier call's positions; their outputs are never read.
    // serveSlots copies the batch out of wasm memory into a plain ArrayBuffer.
    device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>, 0, batch * inputValues);
    const out = await session.run({ [inputName]: inputs[index] });
    if (!widths) {
      widths = outputNames.map((name) => out[name].dims.slice(1).reduce((a, b) => a * b, 1));
      staging = device.createBuffer({
        size: capacity * widths.reduce((a, b) => a + b, 0) * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
    }
    // Copy the used rows of every output side by side and read them back in one map.
    const encoder = device.createCommandEncoder();
    const offsets: number[] = [];
    let offset = 0;
    outputNames.forEach((name, i) => {
      offsets.push(offset);
      const bytes = batch * widths![i] * 4;
      encoder.copyBufferToBuffer(out[name].gpuBuffer as GPUBuffer, 0, staging!, offset, bytes);
      offset += bytes;
    });
    device.queue.submit([encoder.finish()]);
    const readStart = performance.now();
    await staging!.mapAsync(GPUMapMode.READ, 0, offset);
    readMs += performance.now() - readStart;
    const mapped = new Float32Array(staging!.getMappedRange(0, offset).slice(0));
    staging!.unmap();
    const byName = new Map(outputNames.map((name, i) => [name, mapped.subarray(offsets[i] / 4, offsets[i] / 4 + batch * widths![i])]));
    for (const name of outputNames) out[name].dispose();
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
        run = await capturedRunner(ort, init.model, capacity, slots[0]?.batch ?? capacity, registry.inputValues);
      } catch (error) {
        console.warn("graph capture unavailable, using plain WebGPU", error);
        run = await plainRunner(ort, init.model, "webgpu");
      }
    } else {
      run = await plainRunner(ort, init.model, "wasm");
    }

    // Warm up (and capture) every batch size so the first real requests do not
    // pay for shader compilation.
    const warmStart = performance.now();
    const warmSizes = init.backend === "webgpu" ? captureSizes(capacity, slots[0]?.batch ?? capacity) : [capacity];
    for (const size of warmSizes) {
      await run(new Float32Array(size * registry.inputValues), size);
      await run(new Float32Array(size * registry.inputValues), size);
    }
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
          post({ type: "stats", positions, calls, busyMs: busy, windowMs: now - lastReport, readMs });
          readMs = 0;
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
