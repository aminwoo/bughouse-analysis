// Reviews a chess.com game headlessly: npx tsx engine/test/review.ts A.json B.json [nodes]
import fs from "node:fs";
import { NodeEngine } from "./nodeEngine";
import { importChessComGames } from "../../src/lib/chesscom";
import { buildFromImport } from "../../src/lib/game";
import { buildTree } from "../../src/lib/tree";
import { runReview } from "../../src/engine/reviewRunner";
import { reviewMoves, summarize, whiteValueAt, type PositionEval } from "../../src/lib/review";
import type { EngineClient } from "../../src/engine/engineClient";

const [aPath, bPath, nodesArg, outPath] = process.argv.slice(2);
const game = buildFromImport(importChessComGames(JSON.parse(fs.readFileSync(aPath, "utf8")), JSON.parse(fs.readFileSync(bPath, "utf8"))));
const tree = buildTree(game);
console.log(`${game.title}: ${game.moves.length} moves, dropped ${game.droppedMoves}`);
const engine = await NodeEngine.create({ engines: 4 });
const evals: PositionEval[] = [];
const t0 = performance.now();
await runReview(engine as unknown as EngineClient, game, tree, {
  nodes: Number(nodesArg ?? 400),
  existing: [],
  onEval: (e) => {
    evals[e.ply] = e;
    process.stderr.write(`\r${e.ply}/${game.moves.length}`);
  },
  isCancelled: () => false,
});
console.log(`\nreviewed in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (outPath) fs.writeFileSync(outPath, JSON.stringify(evals));
const reviews = reviewMoves(game, evals);
for (let ply = 1; ply <= game.moves.length; ply++) {
  const m = game.moves[ply - 1];
  const r = reviews[ply]!;
  const e = evals[ply - 1];
  console.log(
    `${String(ply).padStart(3)} ${m.board}${m.number}${m.color === "white" ? " " : "'"} ${m.san.padEnd(8)} ` +
      `W=${whiteValueAt(evals[ply]).toFixed(2).padStart(5)} ` +
      `[${e.team[0]} lead ${(e.clock.leadMs / 1000).toFixed(1).padStart(5)}s ${e.search.value.toFixed(2)}] ` +
      `loss=${r.loss.toFixed(2)} ${r.judgement ?? ""} ${r.judgement ? "best " + (r.best ?? "sit") : ""}`,
  );
}
console.log(JSON.stringify(summarize(game, reviews, evals.map((e) => (e ? whiteValueAt(e) : null))), null, 1));
await engine.close();
process.exit(0);
