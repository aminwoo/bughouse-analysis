// Drives the WebAssembly engine from Node with real network inference.
//
//   node engine/test/harness.mjs [--engines N] [--batch B] [--model path] [cmd ...]
//
// Each extra argument is a UCI command; "wait" waits for the next bestmove.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const engines = Number(opt("--engines", "2"));
const fake = args.includes("--fake");
if (fake) args.splice(args.indexOf("--fake"), 1);
const batch = Number(opt("--batch", "8"));
const modelPath = path.resolve(opt("--model", path.join(root, "public/engine/twin-s.onnx")));
const enginePath = path.resolve(opt("--engine", path.join(root, "engine/build/hivemind.js")));
const commands = args.length ? args : ["uci", "isready", "position startpos", "go nodes 400", "wait"];

const { default: createHivemind } = await import(enginePath);
let lineWaiters = [];
const onLine = (line) => {
  console.log(line);
  lineWaiters = lineWaiters.filter((w) => !w(line));
};
const waitFor = (predicate) => new Promise((resolve) => lineWaiters.push((line) => (predicate(line) ? (resolve(line), true) : false)));

const ready = waitFor((l) => l.includes("hivemind web ready") || l.includes("failed to initialize"));
const t0 = performance.now();
const mod = await createHivemind({
  arguments: ["--engines", String(engines), "--batch-size", String(batch), "--model", "/model.onnx"],
  pthreadPoolSize: engines + 8,
  print: onLine,
  printErr: (l) => console.error("[err]", l),
  preRun: [(m) => m.FS.writeFile("/model.onnx", "placeholder")],
});
await ready;
console.error(`[harness] engine ready in ${(performance.now() - t0).toFixed(0)} ms`);

const registryPtr = mod._hm_inference_registry();
const workers = [];
for (let i = 0; i < engines; i++) {
  const w = new Worker(path.join(here, "inference-worker.mjs"), {
    workerData: { memory: mod.wasmMemory, registryPtr, slotIndices: [i], modelPath, merge: false, fake },
  });
  await new Promise((resolve) => w.once("message", resolve));
  workers.push(w);
}
console.error(`[harness] ${workers.length} inference workers ready`);

const send = (cmd) => mod.ccall("hm_command", null, ["string"], [cmd]);
for (const cmd of commands) {
  if (cmd === "wait") {
    await waitFor((l) => l.startsWith("bestmove"));
    continue;
  }
  if (cmd.startsWith("sleep ")) {
    await new Promise((r) => setTimeout(r, Number(cmd.slice(6))));
    continue;
  }
  console.error(`> ${cmd}`);
  send(cmd);
  if (cmd === "isready") await waitFor((l) => l === "readyok");
}
send("stop");
// A worker blocked in Atomics.wait cannot answer, so give up after a moment.
const stats = await Promise.all(workers.map((w) => Promise.race([
  new Promise((resolve) => {
    w.once("message", resolve);
    w.postMessage("stats");
  }),
  new Promise((resolve) => setTimeout(() => resolve(null), 500)),
])));
console.error("[harness] inference stats", stats);
process.exit(0);
