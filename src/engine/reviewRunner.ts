// Drives the engine through a game review, one mainline position at a time.

import { teamOf, BOARDS } from "../lib/bughouse";
import type { GameRecord } from "../lib/game";
import { engineMove, engineRequestFor, type Tree } from "../lib/tree";
import { clockAt, teamMoveTimes, teamToSearch, type PositionEval, type PositionSearch } from "../lib/review";
import type { EngineClient, SearchClock, SearchResult } from "./engineClient";

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
function terminalEval(tree: Tree, ply: number, team: PositionEval["team"], clock: SearchClock): PositionEval | null {
  const node = tree.nodes.get(tree.mainline[ply]);
  if (!node) return null;
  for (const board of BOARDS) {
    if (node.position.isMate(board)) {
      const loser = teamOf(board, node.position.turn(board));
      const value = loser === team ? -1 : 1;
      const search: PositionSearch = { value, mate: 0, best: null, pv: [], nodes: 0 };
      return { ply, team, clock, search };
    }
  }
  return null;
}

export interface ReviewOptions {
  /** Thinking time per search, so the root mate scans run as well. */
  movetimeMs: number;
  /** Plies already evaluated (e.g. from the cache) are skipped. */
  existing: (PositionEval | undefined)[];
  onEval: (e: PositionEval) => void;
  isCancelled: () => boolean;
}

export async function runReview(engine: EngineClient, game: GameRecord, tree: Tree, options: ReviewOptions): Promise<void> {
  const total = game.moves.length + 1;
  const moveTimes = teamMoveTimes(game);
  for (let ply = 0; ply < total; ply++) {
    if (options.isCancelled()) return;
    if (options.existing[ply]) continue;
    const team = teamToSearch(game, ply);
    const clock = clockAt(game, ply, team, moveTimes);
    const terminal = terminalEval(tree, ply, team, clock);
    if (terminal) {
      options.onEval(terminal);
      continue;
    }
    const request = { ...engineRequestFor(tree, game, tree.mainline[ply]), team, clock, movetime: options.movetimeMs };
    const next = game.moves[ply];
    const result = await engine.search(request);
    if (options.isCancelled()) return;
    const search = toSearch(result);
    // Value the move actually played with a second search of this same
    // position restricted to it, unless it was the engine's own choice.
    const best = result.best ? (next?.board === "A" ? result.best.a : result.best.b) : undefined;
    if (next && best !== next.uci) {
      const forced = await engine.search({ ...request, searchMoves: [engineMove(next)] });
      if (options.isCancelled()) return;
      if (forced.info) search.played = forced.info.value;
    }
    options.onEval({ ply, team, clock, search });
  }
}
