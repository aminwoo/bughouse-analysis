// Node stand-in for EngineClient: the WebAssembly engine with onnxruntime-node
// inference in worker threads. Used by tests and the review script.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseInfo, parseJointMove, type SearchInfo, type SearchRequest, type SearchResult } from "../../src/engine/engineClient";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

export interface NodeEngineOptions {
  engines?: number;
  batch?: number;
  model?: string;
  enginePath?: string;
  verbose?: boolean;
}

export class NodeEngine {
  private send!: (cmd: string) => void;
  private listeners: ((line: string) => void)[] = [];
  private workers: Worker[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  static async create(options: NodeEngineOptions = {}): Promise<NodeEngine> {
    const engine = new NodeEngine();
    await engine.init(options);
    return engine;
  }

  private async init(options: NodeEngineOptions) {
    const engines = options.engines ?? 4;
    const batch = options.batch ?? 8;
    const model = path.resolve(options.model ?? path.join(root, "public/engine/twin-s.onnx"));
    const enginePath = path.resolve(options.enginePath ?? path.join(root, "engine/build/hivemind.js"));
    const { default: createHivemind } = await import(enginePath);
    let ready!: () => void;
    const readyPromise = new Promise<void>((r) => (ready = r));
    const mod = await createHivemind({
      arguments: ["--engines", String(engines), "--batch-size", String(batch), "--model", "/model.onnx"],
      print: (line: string) => {
        if (options.verbose) console.log(line);
        if (line.includes("hivemind web ready")) ready();
        for (const l of this.listeners) l(line);
      },
      printErr: (line: string) => console.error("[engine]", line),
      preRun: [(m: { FS: { writeFile: (p: string, d: string) => void } }) => m.FS.writeFile("/model.onnx", "x")],
    });
    await readyPromise;
    const registryPtr = mod._hm_inference_registry();
    for (let i = 0; i < engines; i++) {
      const w = new Worker(path.join(here, "inference-worker.mjs"), {
        workerData: { memory: mod.wasmMemory, registryPtr, slotIndices: [i], modelPath: model, merge: false },
      });
      await new Promise((resolve) => w.once("message", resolve));
      this.workers.push(w);
    }
    this.send = (cmd) => mod.ccall("hm_command", null, ["string"], [cmd]);
    this.send("setoption name Ponder value false");
  }

  search(request: SearchRequest): Promise<SearchResult> {
    const run = () =>
      new Promise<SearchResult>((resolve) => {
        const lines = new Map<number, SearchInfo>();
        const listener = (line: string) => {
          const info = parseInfo(line);
          if (info) {
            lines.set(info.multipv, info);
            request.onInfo?.(info);
          } else if (line.startsWith("bestmove")) {
            this.listeners = this.listeners.filter((l) => l !== listener);
            this.send("stop");
            const sorted = [...lines.values()].sort((a, b) => a.multipv - b.multipv);
            resolve({ best: parseJointMove(line.split(/\s+/)[1] ?? ""), info: sorted[0] ?? null, lines: sorted });
          }
        };
        this.listeners.push(listener);
        this.send("ucinewgame");
        this.send(`setoption name MultiPV value ${request.multipv ?? 1}`);
        this.send(`setoption name Team value ${request.team}`);
        this.send(`setoption name TimeAdvantage value ${request.timeAdvantage}`);
        this.send(`position ${request.position}${request.moves.length ? " moves " + request.moves.join(" ") : ""}`);
        this.send(request.nodes ? `go nodes ${request.nodes}` : `go movetime ${request.movetime ?? 1000}`);
      });
    const result = this.chain.then(run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
