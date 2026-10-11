// Measures search speed through the Node harness: nodes per second for the
// start position and two positions from the sample game, per engine count.
//
//   npx tsx engine/test/bench.ts [--fake] [--engines 1,2,4,8] [--nodes 3000] [--engine path/to/hivemind.js]
//
// --fake answers inference instantly (see inference-worker.mjs), measuring the
// search alone; otherwise inference runs on onnxruntime-node, one CPU thread
// per engine.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importChessComGames, type ChessComGame } from "../../src/lib/chesscom";
import { buildFromImport } from "../../src/lib/game";
import { buildTree, engineMoves } from "../../src/lib/tree";
import { teamToSearch } from "../../src/lib/review";
import gameA from "../../tests/fixtures/159878252255.json";
import gameB from "../../tests/fixtures/159878252253.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const fake = args.includes("--fake");
const engineCounts = opt("--engines", "1,2,4,8").split(",").map(Number);
const nodes = Number(opt("--nodes", "3000"));
const enginePath = opt("--engine", "");

const game = buildFromImport(importChessComGames(gameA as unknown as ChessComGame, gameB as unknown as ChessComGame));
const tree = buildTree(game);
const positions = [
  { name: "start", moves: [] as string[], team: "white" },
  ...[30, 60].map((ply) => ({ name: `ply ${ply}`, moves: engineMoves(tree, tree.mainline[ply]), team: teamToSearch(game, ply) })),
];

const results: Record<string, string | number>[] = [];
for (const engines of engineCounts) {
  const row: Record<string, string | number> = { engines };
  for (const p of positions) {
    const commands = [
      "uci",
      "isready",
      `setoption name Team value ${p.team}`,
      "setoption name TimeAdvantage value false",
      `position startpos${p.moves.length ? " moves " + p.moves.join(" ") : ""}`,
      `go nodes ${nodes}`,
      "wait",
    ];
    const run = spawnSync(
      "node",
      [path.join(here, "harness.mjs"), "--engines", String(engines), ...(fake ? ["--fake"] : []), ...(enginePath ? ["--engine", enginePath] : []), ...commands],
      { encoding: "utf8", maxBuffer: 64 << 20 },
    );
    const infos = run.stdout.split("\n").filter((l) => l.startsWith("info depth"));
    const nps = Number(infos.at(-1)?.match(/ nps (\d+)/)?.[1] ?? NaN);
    row[p.name] = nps;
  }
  results.push(row);
}
console.log(`${fake ? "fake" : "onnxruntime-node"} inference, ${nodes} nodes`);
console.table(results);
