// Measures the engine in a real browser: drives a separate headless Chrome
// over the DevTools protocol through engine-test.html, once per configuration,
// and reports nodes per second with the inference stats.
//
//   npx tsx engine/test/gpu-bench.ts [--url http://localhost:5173] [--nodes 20000] [--backend webgpu]
//       [--configs 8x2,16x2,16x4]   # slots x GPU workers (WebGPU) or threads (wasm)
//
// Needs the dev server running (npm run dev).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importChessComGames, type ChessComGame } from "../../src/lib/chesscom";
import { buildFromImport } from "../../src/lib/game";
import { buildTree, engineMoves } from "../../src/lib/tree";
import { teamToSearch } from "../../src/lib/review";
import gameA from "../../tests/fixtures/159878252255.json";
import gameB from "../../tests/fixtures/159878252253.json";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const base = opt("--url", "http://localhost:5173");
const nodes = Number(opt("--nodes", "20000"));
const backend = opt("--backend", "webgpu");
const configs = opt("--configs", backend === "webgpu" ? "8x2,16x2,16x4,32x4" : "6,8,12").split(",");
const port = 9333;

// A middlegame position from the sample game, where the trees are realistic.
const game = buildFromImport(importChessComGames(gameA as unknown as ChessComGame, gameB as unknown as ChessComGame));
const ply = 40;
const position = { moves: engineMoves(buildTree(game), buildTree(game).mainline[ply]), team: teamToSearch(game, ply) };

const profile = mkdtempSync(path.join(os.tmpdir(), "hm-chrome-"));
const chrome = spawn("google-chrome", [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  // What it takes for headless Chrome on Linux to use the real GPU for WebGPU.
  "--no-sandbox",
  "--use-angle=vulkan",
  "--enable-features=Vulkan",
  "--disable-vulkan-surface",
  "--enable-unsafe-webgpu",
  "about:blank",
]);
const stop = () => {
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
};
process.on("exit", stop);

async function devtools(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = (await (await fetch(`http://localhost:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome did not start");
}

const socket = new WebSocket(await devtools());
await new Promise((r) => socket.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
  if (message.id && pending.has(message.id)) pending.get(message.id)!(message.result);
});
const call = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression: string) => (await call("Runtime.evaluate", { expression, returnByValue: true })).result?.value;

const rows: Record<string, string | number>[] = [];
for (const config of configs) {
  const [slots, gpuWorkers] = config.split("x").map(Number);
  const query = new URLSearchParams({
    backend,
    nodes: String(nodes),
    moves: position.moves.join(","),
    team: position.team,
    ta: "false",
    ...(backend === "webgpu" ? { slots: String(slots), gpuw: String(gpuWorkers ?? 2) } : { threads: String(slots) }),
  });
  const started = performance.now();
  let readyMs = 0;
  await call("Page.navigate", { url: `${base}/engine-test.html?${query}` });
  let result: { ms: number; result: { info: { nodes: number } }; info: { backend: string } } | null = null;
  for (let i = 0; i < 600 && !result; i++) {
    await new Promise((r) => setTimeout(r, 500));
    result = await evaluate("window.engineResult ?? null");
    const status = await evaluate("document.body.innerText.slice(0, 80)");
    if (typeof status === "string" && status.startsWith("error")) throw new Error(status);
    if (!readyMs && typeof status === "string" && !status.startsWith("ready")) readyMs = 0;
    else if (!readyMs) readyMs = performance.now() - started;
    if (process.env.DEBUG && i % 4 === 0) console.error(`[${config}] ${String(status).split("\n")[0]}`);
  }
  if (!result) throw new Error(`timed out on ${config}`);
  const stats = ((await evaluate("window.engineStats ?? []")) as { nps: number; busy: number; batchAvg: number; callMs: number; readMs: number }[]).filter((s) => s.nps > 0);
  const mean = (key: "busy" | "batchAvg" | "callMs" | "readMs") => stats.reduce((sum, s) => sum + s[key], 0) / Math.max(1, stats.length);
  rows.push({
    config,
    backend: result.info.backend,
    nps: Math.round((result.result.info.nodes * 1000) / result.ms),
    "batch/call": Number(mean("batchAvg").toFixed(1)),
    "call ms": Number(mean("callMs").toFixed(1)),
    "read ms": Number(mean("readMs").toFixed(1)),
    "busy %": Math.round(mean("busy") * 100),
    "startup s": Number((readyMs / 1000).toFixed(1)),
  });
  console.error(JSON.stringify(rows.at(-1)));
}
console.log(`${backend}, ply ${ply} of the sample game, ${nodes} nodes`);
console.table(rows);
socket.close();
process.exit(0);
