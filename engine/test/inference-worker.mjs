// worker_threads inference server for the Node harness (onnxruntime-node).
import { parentPort, workerData } from "node:worker_threads";
import * as ort from "onnxruntime-node";
import { serveSlots, readRegistry, mapOutputNames } from "../../src/engine/inferenceCore.ts";

const { memory, registryPtr, slotIndices, modelPath, merge, fake } = workerData;
const session = await ort.InferenceSession.create(modelPath, {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: "all",
});
const names = mapOutputNames(session.outputNames);
const registry = readRegistry(memory, registryPtr);
const slots = registry.slots.filter((s) => slotIndices.includes(s.index));
let cached = null;
const WIDTH = { value: 1, policyA: 4672, policyB: 4672, wdl: 3, movesLeft: 1 };
/** Repeats the first row of each output `batch` times. */
function tile(first, batch) {
  const out = {};
  for (const [key, data] of Object.entries(first)) {
    const width = WIDTH[key];
    const tiled = new Float32Array(batch * width);
    for (let i = 0; i < batch; i++) tiled.set(data.subarray(0, width), i * width);
    out[key] = tiled;
  }
  return out;
}
let positions = 0;
let busy = 0;
parentPort.postMessage({ type: "ready", slots: slots.map((s) => s.index) });
parentPort.on("message", (m) => {
  if (m === "stats") parentPort.postMessage({ type: "stats", positions, busy });
});
await serveSlots({
  memory,
  registry,
  slots,
  mergeBatches: merge,
  onBatch: (n, ms) => { positions += n; busy += ms; },
  run: async (input, batch) => {
    // --fake: evaluate the first position for real, then answer every request
    // with it instantly, to measure the search without inference cost.
    if (fake && cached) return tile(cached, batch);
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [batch, registry.inputValues / 64, 8, 8]) });
    const result = {
      value: out[names.value].data,
      policyA: out[names.policyA].data,
      policyB: out[names.policyB].data,
      wdl: out[names.wdl].data,
      movesLeft: out[names.movesLeft].data,
    };
    if (fake) cached = result;
    return result;
  },
});

