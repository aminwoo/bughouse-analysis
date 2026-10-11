// Game review: evaluates every mainline position and judges each move.
//
// Hivemind's value depends heavily on whether the searching team holds the
// time advantage (it may then sit, the opponents may not), so each position is
// searched twice, with and without it, and the two values are blended by how
// likely the team is to be up on time given the real clocks. A move is judged
// by how far its value falls below the engine's best from the same position:
// each search is repeated restricted to the move actually played, so both
// values come from one position, team and clock setting. The blend weight is
// that of the position before the move, so thinking time is not counted as a
// move error.

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
  /**
   * Value of the game's next move from this position, searched with the root
   * restricted to it. Absent when the move was this search's own choice.
   */
  played?: number;
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

/** lichess's accuracy for one move, from the mover's value before and after. */
export function moveAccuracy(before: number, after: number): number {
  const drop = winPercent(before) - winPercent(after);
  if (drop <= 0) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * drop) - 3.166924740191411;
  // lichess adds a point for the imperfect analysis.
  return Math.max(0, Math.min(100, raw + 1));
}

function standardDeviation(xs: number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
}

/**
 * lichess's per-move weights: how volatile the white win percentage is around
 * each move, so moves in sharp positions count for more. `whiteWin` has one
 * entry per position (moves + 1); the result has one per move.
 */
export function volatilityWeights(whiteWin: number[]): number[] {
  const moves = whiteWin.length - 1;
  if (moves < 1) return [];
  const size = Math.max(2, Math.min(8, Math.floor(moves / 10)));
  const windows: number[][] = Array.from({ length: size - 2 }, () => whiteWin.slice(0, size));
  for (let i = 0; i + size <= whiteWin.length; i++) windows.push(whiteWin.slice(i, i + size));
  return windows.slice(0, moves).map((w) => Math.max(0.5, Math.min(12, standardDeviation(w))));
}

/**
 * lichess's game accuracy: the average of the volatility-weighted mean and the
 * harmonic mean of the move accuracies. The harmonic mean keeps a few bad
 * moves from being hidden by many easy ones.
 */
export function gameAccuracy(moves: { accuracy: number; weight: number }[]): number | null {
  if (!moves.length) return null;
  const weighted = moves.reduce((s, m) => s + m.accuracy * m.weight, 0) / moves.reduce((s, m) => s + m.weight, 0);
  const harmonic = moves.length / moves.reduce((s, m) => s + 1 / Math.max(1, m.accuracy), 0);
  return (weighted + harmonic) / 2;
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

/** Blended value of the game's next move from `e`, for the searching team. */
export function playedValue(e: PositionEval, weight: number): number {
  return weight * (e.withTA.played ?? e.withTA.value) + (1 - weight) * (e.withoutTA.played ?? e.withoutTA.value);
}

export function bestFor(e: PositionEval, weight: number): JointMove | null {
  return (weight >= 0.5 ? e.withTA.best : e.withoutTA.best) ?? e.withTA.best ?? e.withoutTA.best;
}

export function reviewMoves(game: GameRecord, evals: (PositionEval | undefined)[], model: ClockModel): (MoveReview | null)[] {
  const out: (MoveReview | null)[] = [null];
  for (let ply = 1; ply <= game.moves.length; ply++) {
    const move = game.moves[ply - 1];
    const before = evals[ply - 1];
    const team = teamOf(move.board, move.color);
    // Mainline positions are searched for the team that moves next.
    if (!before || before.team !== team) {
      out.push(null);
      continue;
    }
    const weight = timeAdvantageWeight(clocksAt(game, ply - 1), team, model);
    const best = bestFor(before, weight);
    const bestHere = best ? (move.board === "A" ? best.a : best.b) : undefined;
    const vBefore = blend(before, weight);
    const vAfter = playedValue(before, weight);
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

export interface TeamSummary {
  team: TeamId;
  /** The team's two players: board A first. */
  players: [PlayerSummary, PlayerSummary];
  moves: number;
  /** Game accuracy over all of the team's reviewed moves. */
  accuracy: number | null;
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

function summarizeMoves(moves: MoveReview[], weights: number[]) {
  return {
    moves: moves.length,
    accuracy: gameAccuracy(moves.map((r) => ({ accuracy: r.accuracy, weight: weights[r.ply - 1] ?? 0.5 }))),
    inaccuracy: moves.filter((r) => r.judgement === "inaccuracy").length,
    mistake: moves.filter((r) => r.judgement === "mistake").length,
    blunder: moves.filter((r) => r.judgement === "blunder").length,
  };
}

/**
 * Per-team totals, white team first, each with its two players. `whiteCurve`
 * is the white team's value at each mainline position (null if unreviewed),
 * which sets lichess's volatility weights.
 */
export function summarize(game: GameRecord, reviews: (MoveReview | null)[], whiteCurve: (number | null)[]): TeamSummary[] {
  // Unreviewed positions repeat the last known value.
  let last = 0;
  const whiteWin = Array.from({ length: game.moves.length + 1 }, (_, ply) => winPercent((last = whiteCurve[ply] ?? last)));
  const weights = volatilityWeights(whiteWin);
  const movesBy = (match: (board: BoardId, color: "white" | "black") => boolean) =>
    reviews.filter((r, i) => r && game.moves[i - 1] && match(game.moves[i - 1].board, game.moves[i - 1].color)) as MoveReview[];
  const player = (board: BoardId, color: "white" | "black"): PlayerSummary => ({
    board,
    color,
    ...summarizeMoves(movesBy((b, c) => b === board && c === color), weights),
  });
  return (["white", "black"] as const).map((team) => ({
    team,
    players: team === "white" ? [player("A", "white"), player("B", "black")] : [player("A", "black"), player("B", "white")],
    ...summarizeMoves(movesBy((b, c) => teamOf(b, c) === team), weights),
  }));
}
