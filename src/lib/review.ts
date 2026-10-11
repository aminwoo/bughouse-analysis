// Game review: evaluates every mainline position and judges each move.
//
// Hivemind's value depends heavily on whether the searching team holds the
// time advantage (it may then sit, the opponents may not), so each position is
// searched twice, with and without it, and the two values are blended by how
// likely the team is to be up on time given the real clocks. A move is judged
// by how much it lowers its team's blended value, holding that weight fixed so
// that thinking time alone is not counted as a move error.

import { otherTeam, teamOf, type BoardId, type TeamId } from "./bughouse";
import type { Clocks, GameRecord } from "./game";
import type { JointMove } from "../engine/engineClient";

export interface PositionSearch {
  /** Searching team's value in [-1, 1]. */
  value: number;
  mate: number | null;
  best: JointMove | null;
  pv: JointMove[];
  nodes: number;
}

export interface PositionEval {
  ply: number;
  team: TeamId;
  withTA: PositionSearch;
  withoutTA: PositionSearch;
}

export type ClockModel = "clocks" | "neutral" | "binary";

export const JUDGEMENTS = [
  { name: "blunder", loss: 0.3, glyph: "??" },
  { name: "mistake", loss: 0.2, glyph: "?" },
  { name: "inaccuracy", loss: 0.1, glyph: "?!" },
] as const;

export type Judgement = (typeof JUDGEMENTS)[number]["name"];

export interface MoveReview {
  /** Index of the move in the mainline (1 = first move). */
  ply: number;
  team: TeamId;
  board: BoardId;
  /** Mover's team value before and after, same time-advantage weight. */
  before: number;
  after: number;
  loss: number;
  judgement: Judgement | null;
  /** Engine's preferred action on the move's board: UCI, or null to sit. */
  best: string | null | undefined;
  accuracy: number;
}

/** Seconds of clock difference that make the time advantage ~73% likely. */
const CLOCK_SCALE_DS = 30;

/** Diagonal clock difference for a team, deciseconds (positive = ahead). */
export function clockLead(clocks: Clocks, team: TeamId): number {
  return team === "white" ? clocks.A.white - clocks.B.white : clocks.A.black - clocks.B.black;
}

/** Probability that `team` holds the time advantage. */
export function timeAdvantageWeight(clocks: Clocks | null, team: TeamId, model: ClockModel): number {
  if (!clocks || model === "neutral") return 0.5;
  const lead = clockLead(clocks, team);
  if (model === "binary") return lead > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-lead / CLOCK_SCALE_DS));
}

export function blend(e: PositionEval, weight: number): number {
  return weight * e.withTA.value + (1 - weight) * e.withoutTA.value;
}

/** Blended value from `team`'s point of view, given `team`'s TA weight. */
export function valueFor(e: PositionEval, team: TeamId, weight: number): number {
  if (e.team === team) return blend(e, weight);
  // The opponents searched: their TA=true world is our TA=false one.
  return -blend(e, 1 - weight);
}

export function winPercent(value: number): number {
  return 50 + 50 * Math.max(-1, Math.min(1, value));
}

/** lichess's accuracy curve on win-percentage loss. */
export function moveAccuracy(before: number, after: number): number {
  const drop = Math.max(0, winPercent(before) - winPercent(after));
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

/** Team whose decision a mainline position represents. */
export function teamToSearch(game: GameRecord, ply: number): TeamId {
  if (ply < game.moves.length) return teamOf(game.moves[ply].board, game.moves[ply].color);
  const last = game.moves[ply - 1];
  return last ? otherTeam(teamOf(last.board, last.color)) : "white";
}

/** Clocks at a mainline position (after `ply` moves). */
export function clocksAt(game: GameRecord, ply: number): Clocks | null {
  return ply === 0 ? game.startClocks : game.moves[ply - 1]?.clocks ?? null;
}

export function whiteValueAt(game: GameRecord, e: PositionEval, model: ClockModel): number {
  const weight = timeAdvantageWeight(clocksAt(game, e.ply), "white", model);
  return valueFor(e, "white", weight);
}

export function bestFor(e: PositionEval, weight: number): JointMove | null {
  return (weight >= 0.5 ? e.withTA.best : e.withoutTA.best) ?? e.withTA.best ?? e.withoutTA.best;
}

export function reviewMoves(game: GameRecord, evals: (PositionEval | undefined)[], model: ClockModel): (MoveReview | null)[] {
  const out: (MoveReview | null)[] = [null];
  for (let ply = 1; ply <= game.moves.length; ply++) {
    const move = game.moves[ply - 1];
    const before = evals[ply - 1];
    const after = evals[ply];
    if (!before || !after) {
      out.push(null);
      continue;
    }
    const team = teamOf(move.board, move.color);
    const weight = timeAdvantageWeight(clocksAt(game, ply - 1), team, model);
    const best = before.team === team ? bestFor(before, weight) : null;
    const bestHere = best ? (move.board === "A" ? best.a : best.b) : undefined;
    const vAfter = valueFor(after, team, weight);
    // When the move is the engine's own choice, a lower value afterwards is the
    // engine seeing deeper, not a mistake by the player.
    const vBefore = bestHere === move.uci ? Math.min(valueFor(before, team, weight), vAfter) : valueFor(before, team, weight);
    const loss = Math.max(0, vBefore - vAfter);
    const judgement = JUDGEMENTS.find((j) => loss >= j.loss)?.name ?? null;
    out.push({
      ply,
      team,
      board: move.board,
      before: vBefore,
      after: vAfter,
      loss,
      judgement,
      best: bestHere,
      accuracy: moveAccuracy(vBefore, vAfter),
    });
  }
  return out;
}

export interface PlayerSummary {
  board: BoardId;
  color: "white" | "black";
  moves: number;
  accuracy: number | null;
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

export function summarize(game: GameRecord, reviews: (MoveReview | null)[]): PlayerSummary[] {
  const seats: [BoardId, "white" | "black"][] = [["A", "white"], ["B", "black"], ["A", "black"], ["B", "white"]];
  return seats.map(([board, color]) => {
    const mine = reviews.filter((r, i) => r && game.moves[i - 1]?.board === board && game.moves[i - 1]?.color === color) as MoveReview[];
    return {
      board,
      color,
      moves: mine.length,
      accuracy: mine.length ? mine.reduce((s, r) => s + r.accuracy, 0) / mine.length : null,
      inaccuracy: mine.filter((r) => r.judgement === "inaccuracy").length,
      mistake: mine.filter((r) => r.judgement === "mistake").length,
      blunder: mine.filter((r) => r.judgement === "blunder").length,
    };
  });
}
