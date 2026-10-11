// A loaded game: its starting position, players and the merged mainline with
// clock states, built from a chess.com import or a hand-made setup.

import { BughousePosition, teamOf, type BoardId, type PlayedMove, type TeamId } from "./bughouse";
import { elapsedTimes, type ImportedGame, type PlayerInfo } from "./chesscom";

export interface Clocks {
  A: { white: number; black: number };
  B: { white: number; black: number };
}

export interface MainlineMove extends PlayedMove {
  /** Deciseconds since the start of the game. */
  elapsed: number;
  /** All four clocks right after this move, deciseconds. */
  clocks: Clocks;
  /** How long the mover thought, deciseconds. */
  thinkTime: number;
  /** Move number on its own board, 1-based. */
  number: number;
}

export interface GameRecord {
  /** Stable key for caching analysis, e.g. "chesscom:159878252255". */
  key: string;
  title: string;
  players: { aWhite: PlayerInfo; aBlack: PlayerInfo; bWhite: PlayerInfo; bBlack: PlayerInfo };
  /** Starting FENs, or null for the standard start on both boards. */
  startFens: { A: string; B: string } | null;
  startClocks: Clocks | null;
  moves: MainlineMove[];
  result?: { winner: TeamId | "draw" | null; message: string };
  source?: { site: "chess.com"; ids: { A: string; B: string | null } };
  date?: string;
  timeControl?: string;
  /** Moves that could not be replayed (corrupt or truncated data). */
  droppedMoves: number;
}

export function startPosition(game: Pick<GameRecord, "startFens">): BughousePosition {
  return game.startFens ? BughousePosition.fromFens(game.startFens.A, game.startFens.B, false) : BughousePosition.initial();
}

/** Engine `position` argument for the game's start. */
export function enginePositionArg(game: Pick<GameRecord, "startFens">): string {
  return game.startFens ? `fen ${game.startFens.A} | ${game.startFens.B}` : "startpos";
}

function cloneClocks(c: Clocks): Clocks {
  return { A: { ...c.A }, B: { ...c.B } };
}

/**
 * Merges both boards by time, replaying them so that a move recorded in the
 * same decisecond as the capture that made it possible is put after it.
 */
export function buildFromImport(imported: ImportedGame): GameRecord {
  const base = imported.baseTime;
  const inc = imported.incrementDs;
  const times = {
    A: elapsedTimes(imported.boards.A.remaining, base, inc),
    B: elapsedTimes(imported.boards.B.remaining, base, inc),
  };
  const pos = BughousePosition.initial();
  const index = { A: 0, B: 0 };
  const clocks: Clocks = { A: { white: base, black: base }, B: { white: base, black: base } };
  const lastMoveAt = { A: 0, B: 0 };
  let now = 0;
  const moves: MainlineMove[] = [];
  let dropped = 0;

  const candidate = (board: BoardId) => {
    const i = index[board];
    const src = imported.boards[board];
    if (i >= src.moves.length) return null;
    const t = times[board];
    return { board, uci: src.moves[i], elapsed: t[i] ?? t[t.length - 1] ?? now, remaining: src.remaining[i] };
  };

  for (;;) {
    const a = candidate("A");
    const b = candidate("B");
    if (!a && !b) break;
    const ordered = [a, b].filter((c): c is NonNullable<typeof c> => !!c).sort((x, y) => x.elapsed - y.elapsed || (x.board === "A" ? -1 : 1));
    const pick = ordered.find((c) => pos.isLegal(c.board, c.uci));
    if (!pick) {
      // Neither board can continue: the data is inconsistent from here on.
      dropped = imported.boards.A.moves.length - index.A + imported.boards.B.moves.length - index.B;
      break;
    }
    const at = Math.max(now, pick.elapsed);
    const dt = at - now;
    clocks.A[pos.turn("A")] -= dt;
    clocks.B[pos.turn("B")] -= dt;
    now = at;
    const played = pos.play(pick.board, pick.uci);
    if (pick.remaining != null && Number.isFinite(pick.remaining)) clocks[pick.board][played.color] = pick.remaining;
    clocks.A.white = Math.max(0, clocks.A.white);
    clocks.A.black = Math.max(0, clocks.A.black);
    clocks.B.white = Math.max(0, clocks.B.white);
    clocks.B.black = Math.max(0, clocks.B.black);
    moves.push({
      ...played,
      elapsed: at,
      clocks: cloneClocks(clocks),
      thinkTime: at - lastMoveAt[pick.board],
      number: Math.floor(index[pick.board] / 2) + 1,
    });
    lastMoveAt[pick.board] = at;
    index[pick.board]++;
  }

  const p = imported.players;
  const winner = imported.result.winner === "white-team" ? "white" : imported.result.winner === "black-team" ? "black" : imported.result.winner;
  return {
    key: `chesscom:${imported.ids.A}`,
    title: `${p.aWhite.username} & ${p.bBlack.username} vs ${p.aBlack.username} & ${p.bWhite.username}`,
    players: p,
    startFens: null,
    startClocks: { A: { white: base, black: base }, B: { white: base, black: base } },
    moves,
    result: { winner, message: imported.result.message },
    source: { site: "chess.com", ids: imported.ids },
    date: imported.date,
    timeControl: imported.timeControl,
    droppedMoves: dropped,
  };
}

export function buildFromSetup(fenA: string, fenB: string, clocks: Clocks | null): GameRecord {
  const unknown = (name: string): PlayerInfo => ({ username: name });
  return {
    key: `setup:${fenA}|${fenB}`,
    title: "Custom position",
    players: { aWhite: unknown("White A"), aBlack: unknown("Black A"), bWhite: unknown("White B"), bBlack: unknown("Black B") },
    startFens: { A: fenA, B: fenB },
    startClocks: clocks,
    moves: [],
    droppedMoves: 0,
  };
}

export function emptyGame(): GameRecord {
  return {
    key: "empty",
    title: "New game",
    players: {
      aWhite: { username: "White A" },
      aBlack: { username: "Black A" },
      bWhite: { username: "White B" },
      bBlack: { username: "Black B" },
    },
    startFens: null,
    startClocks: null,
    moves: [],
    droppedMoves: 0,
  };
}

/** Team that made a mainline move. */
export function moverTeam(move: Pick<PlayedMove, "board" | "color">): TeamId {
  return teamOf(move.board, move.color);
}
