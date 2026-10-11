// worker_threads inference server for the Node harness (onnxruntime-node).
import { parentPort, workerData } from "node:worker_threads";
import * as ort from "onnxruntime-node";
import { serveSlots, readRegistry, mapOutputNames } from "../../src/engine/inferenceCore.ts";

const { memory, registryPtr, slotIndices, modelPath, merge } = workerData;
const session = await ort.InferenceSession.create(modelPath, {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: "all",
});
const names = mapOutputNames(session.outputNames);
const registry = readRegistry(memory, registryPtr);
const slots = registry.slots.filter((s) => slotIndices.includes(s.index));
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
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [batch, 74, 8, 8]) });
    return {
      value: out[names.value].data,
      policyA: out[names.policyA].data,
      policyB: out[names.policyB].data,
      wdl: out[names.wdl].data,
      movesLeft: out[names.movesLeft].data,
    };
  },
});
