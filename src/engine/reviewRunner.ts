// Drives the engine through a game review, one mainline position at a time.

import { teamOf, BOARDS } from "../lib/bughouse";
import type { GameRecord } from "../lib/game";
import { engineMove, engineRequestFor, type Tree } from "../lib/tree";
import { teamToSearch, type PositionEval, type PositionSearch } from "../lib/review";
import type { EngineClient, SearchResult } from "./engineClient";

function toSearch(result: SearchResult): PositionSearch {
  const info = result.info;
  return {
    value: info?.value ?? 0,
    mate: info?.mate ?? null,
    best: result.best,
    pv: info?.pv ?? [],
    nodes: info?.nodes ?? 0,
  };
}

/** A finished game's final position needs no search when a board is mated. */
function terminalEval(tree: Tree, ply: number, team: PositionEval["team"]): PositionEval | null {
  const node = tree.nodes.get(tree.mainline[ply]);
  if (!node) return null;
  for (const board of BOARDS) {
    if (node.position.isMate(board)) {
      const loser = teamOf(board, node.position.turn(board));
      const value = loser === team ? -1 : 1;
      const search: PositionSearch = { value, mate: 0, best: null, pv: [], nodes: 0 };
      return { ply, team, withTA: search, withoutTA: { ...search } };
    }
  }
  return null;
}

export interface ReviewOptions {
  nodes: number;
  /** Plies already evaluated (e.g. from the cache) are skipped. */
  existing: (PositionEval | undefined)[];
  onEval: (e: PositionEval) => void;
  isCancelled: () => boolean;
}

export async function runReview(engine: EngineClient, game: GameRecord, tree: Tree, options: ReviewOptions): Promise<void> {
  const total = game.moves.length + 1;
  for (let ply = 0; ply < total; ply++) {
    if (options.isCancelled()) return;
    if (options.existing[ply]) continue;
    const team = teamToSearch(game, ply);
    const terminal = terminalEval(tree, ply, team);
    if (terminal) {
      options.onEval(terminal);
      continue;
    }
    const request = engineRequestFor(tree, game, tree.mainline[ply]);
    const next = game.moves[ply];
    const search = async (timeAdvantage: boolean): Promise<PositionSearch | null> => {
      const result = await engine.search({ ...request, team, timeAdvantage, nodes: options.nodes });
      if (options.isCancelled()) return null;
      const out = toSearch(result);
      // Value the move actually played with a second search of this same
      // position restricted to it, unless it was the engine's own choice.
      const best = result.best ? (next?.board === "A" ? result.best.a : result.best.b) : undefined;
      if (next && best !== next.uci) {
        const forced = await engine.search({ ...request, team, timeAdvantage, nodes: options.nodes, searchMoves: [engineMove(next)] });
        if (options.isCancelled()) return null;
        if (forced.info) out.played = forced.info.value;
      }
      return out;
    };
    const withTA = await search(true);
    if (!withTA) return;
    const withoutTA = await search(false);
    if (!withoutTA) return;
    options.onEval({ ply, team, withTA, withoutTA });
  }
}
