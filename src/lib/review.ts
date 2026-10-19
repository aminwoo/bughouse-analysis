// Game review: evaluates every mainline position and judges each move.
//
// Hivemind searches on the real clocks: the searching team's lead over its
// diagonal opponents decides who may sit and for how long, and each team's
// move time what every action it plays while on turn on both boards costs it.
// Each position is searched once on its own clocks. A move is judged by how
// far its value falls below the engine's best from the same position: the
// search is repeated restricted to the move actually played, so both values
// come from one position, team and clock. The clock is that of the position
// before the move, so thinking time is not counted as a move error.

import { otherTeam, teamOf, type BoardId, type TeamId } from "./bughouse";
import type { Clocks, GameRecord } from "./game";
import type { JointMove, SearchClock } from "../engine/engineClient";

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
  /** The clock searched on, from `team`'s side. */
  clock: SearchClock;
  search: PositionSearch;
}

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
  /** Mover's team value before and after, on the same clock. */
  before: number;
  after: number;
  loss: number;
  judgement: Judgement | null;
  /** Engine's preferred action on the move's board: UCI, or null to sit. */
  best: string | null | undefined;
  accuracy: number;
}

/**
 * Nodes a search needs before its value means anything. A timed search whose
 * deadline passes before the root's moves are visited (inference stalled, say
 * in a background tab) reports an unvisited move's value: a certain loss.
 */
export const MIN_SEARCH_NODES = 32;

/** Whether a search ended too soon to trust. A mate is a proof and stands. */
export function isStarved(search: { nodes: number; mate: number | null }): boolean {
  return search.mate == null && search.nodes < MIN_SEARCH_NODES;
}

/** Move time assumed for a team the game says too little about. */
export const DEFAULT_MOVE_TIME_MS = 1000;
/** Move times the clock networks were trained on (0.1-3 s per action). */
const MIN_MOVE_TIME_MS = 100;
const MAX_MOVE_TIME_MS = 3000;
/** Moves a team needs before its own think times set its move time. */
const MIN_TIMED_MOVES = 4;

/** Diagonal clock difference for a team, deciseconds (positive = ahead). */
export function clockLead(clocks: Clocks, team: TeamId): number {
  return team === "white" ? clocks.A.white - clocks.B.white : clocks.A.black - clocks.B.black;
}

function median(xs: number[]): number {
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export type MoveTimes = Record<TeamId, number>;

/**
 * Each team's move time, ms: the median think time of its players' moves in
 * the game. The median keeps long sits from counting as slow moves.
 */
export function teamMoveTimes(game: Pick<GameRecord, "moves">): MoveTimes {
  const of = (team: TeamId) => {
    const thinks = game.moves.filter((m) => teamOf(m.board, m.color) === team && m.thinkTime != null).map((m) => m.thinkTime * 100);
    if (thinks.length < MIN_TIMED_MOVES) return DEFAULT_MOVE_TIME_MS;
    return Math.max(MIN_MOVE_TIME_MS, Math.min(MAX_MOVE_TIME_MS, Math.round(median(thinks))));
  };
  return { white: of("white"), black: of("black") };
}

/**
 * One player's typical think time in the game, ms: the median of their own
 * moves, or null before they have moved. Unlike teamMoveTimes this is not
 * held to the engine's range, since it only describes the player.
 */
export function playerMoveTime(game: Pick<GameRecord, "moves">, board: BoardId, color: "white" | "black"): number | null {
  const thinks = game.moves.filter((m) => m.board === board && m.color === color && m.thinkTime != null).map((m) => m.thinkTime * 100);
  return thinks.length ? Math.round(median(thinks)) : null;
}

/** The clock `team` searches on: its lead (level without clocks) and both move times. */
export function searchClock(clocks: Clocks | null, team: TeamId, moveTimes: MoveTimes): SearchClock {
  return {
    leadMs: clocks ? clockLead(clocks, team) * 100 : 0,
    teamMoveTimeMs: moveTimes[team],
    opponentMoveTimeMs: moveTimes[otherTeam(team)],
  };
}

/** Value from `team`'s point of view. Both teams see the same clock. */
export function valueFor(e: PositionEval, team: TeamId): number {
  return e.team === team ? e.search.value : -e.search.value;
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

/** The clock a mainline position is searched on for `team`. */
export function clockAt(game: GameRecord, ply: number, team: TeamId, moveTimes: MoveTimes = teamMoveTimes(game)): SearchClock {
  return searchClock(clocksAt(game, ply), team, moveTimes);
}

export function whiteValueAt(e: PositionEval): number {
  return valueFor(e, "white");
}

/** Value of the game's next move from `e`, for the searching team. */
export function playedValue(e: PositionEval): number {
  return e.search.played ?? e.search.value;
}

export function reviewMoves(game: GameRecord, evals: (PositionEval | undefined)[]): (MoveReview | null)[] {
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
    const best = before.search.best;
    const bestHere = best ? (move.board === "A" ? best.a : best.b) : undefined;
    const vBefore = before.search.value;
    const vAfter = playedValue(before);
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
