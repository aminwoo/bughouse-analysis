// chess.com live-game payloads → bughouse move timelines.
//
// chess.com stores each board's moves as "TCN": two characters per move, one
// per square (a1 = 'a' … h8 = '?'). Drops put the piece in the first
// character, promotions put the piece and file offset in the second. Clocks
// come as `moveTimestamps`: the mover's remaining time in deciseconds after
// each move. Both boards are merged into one timeline by reconstructing when
// each move happened.

export interface ChessComPlayer {
  username: string;
  rating?: number;
  color?: string;
  chessTitle?: string;
  avatarUrl?: string;
}

export interface ChessComGame {
  game: {
    id: number;
    uuid?: string;
    moveList: string;
    moveTimestamps?: string;
    partnerGameId?: number | string;
    type?: string;
    typeName?: string;
    baseTime1?: number;
    timeIncrement1?: number;
    colorOfWinner?: string;
    gameEndReason?: string;
    resultMessage?: string;
    endTime?: number;
    isFinished?: boolean;
    pgnHeaders?: Record<string, string | number>;
    initialSetup?: string;
  };
  players: { top: ChessComPlayer; bottom: ChessComPlayer };
}

const SQUARES = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?";
const DROP_PIECES: Record<string, string> = { "&": "Q", "-": "N", "*": "R", "+": "B", "=": "P" };
const PROMOTIONS = "{~}(^)[_]@#$";
const FILES = "abcdefgh";

function squareName(index: number): string {
  return FILES[index % 8] + String(Math.floor(index / 8) + 1);
}

/** Decodes a TCN move list into UCI moves (`e2e4`, `e7e8q`, `N@f3`). */
export function decodeTcn(moveList: string): string[] {
  const moves: string[] = [];
  for (let i = 0; i + 1 < moveList.length; i += 2) {
    const a = moveList[i];
    const b = moveList[i + 1];
    const toIndex = SQUARES.indexOf(b);
    if (a in DROP_PIECES) {
      if (toIndex < 0) throw new Error(`bad TCN drop square '${b}'`);
      moves.push(`${DROP_PIECES[a]}@${squareName(toIndex)}`);
      continue;
    }
    const fromIndex = SQUARES.indexOf(a);
    if (fromIndex < 0) throw new Error(`bad TCN square '${a}'`);
    const promotion = PROMOTIONS.indexOf(b);
    if (promotion >= 0) {
      const piece = "qnrb"[Math.floor(promotion / 3)];
      const fileDelta = (promotion % 3) - 1;
      const fromRank = Math.floor(fromIndex / 8);
      const toRank = fromRank === 6 ? 7 : 0;
      const to = toRank * 8 + (fromIndex % 8) + fileDelta;
      moves.push(squareName(fromIndex) + squareName(to) + piece);
      continue;
    }
    if (toIndex < 0) throw new Error(`bad TCN square '${b}'`);
    moves.push(squareName(fromIndex) + squareName(toIndex));
  }
  return moves;
}

export interface BoardSource {
  moves: string[];
  /** Remaining clock after each move, deciseconds. */
  remaining: number[];
}

/**
 * Reconstructs when each move on one board happened. Both clocks on a board
 * start at `base`; at any moment exactly one of them runs, so time elapsed is
 * the total time handed out minus what both players have left.
 */
export function elapsedTimes(remaining: number[], base: number, incrementDs: number): number[] {
  const out: number[] = [];
  let previous = 0;
  for (let i = 0; i < remaining.length; i++) {
    const opponentLeft = i === 0 ? base : remaining[i - 1];
    const given = 2 * base + (i + 1) * incrementDs;
    const elapsed = Math.max(previous, given - (remaining[i] + opponentLeft));
    out.push(elapsed);
    previous = elapsed;
  }
  return out;
}

export interface PlayerInfo {
  username: string;
  rating?: number;
  title?: string;
}

export interface ImportedGame {
  source: "chess.com";
  ids: { A: string; B: string | null };
  players: { aWhite: PlayerInfo; aBlack: PlayerInfo; bWhite: PlayerInfo; bBlack: PlayerInfo };
  /** Initial clock per player in deciseconds. */
  baseTime: number;
  incrementDs: number;
  boards: { A: BoardSource; B: BoardSource };
  result: { winner: "white-team" | "black-team" | "draw" | null; reason: string; message: string };
  date?: string;
  timeControl?: string;
}

function playersByColor(game: ChessComGame | null): { white: PlayerInfo; black: PlayerInfo } {
  const unknown = { username: "?" };
  if (!game) return { white: unknown, black: unknown };
  const { top, bottom } = game.players;
  const info = (p: ChessComPlayer): PlayerInfo => ({
    username: p.username || "?",
    rating: p.rating,
    title: p.chessTitle ? p.chessTitle.toUpperCase() : undefined,
  });
  if ((top.color || "").toLowerCase() === "white") return { white: info(top), black: info(bottom) };
  return { white: info(bottom), black: info(top) };
}

function pgnHeaders(game: ChessComGame): Record<string, string> {
  const raw = game.game.pgnHeaders as unknown;
  if (raw && typeof raw === "object") {
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  }
  return {};
}

function boardSource(game: ChessComGame | null): BoardSource {
  if (!game) return { moves: [], remaining: [] };
  const moves = decodeTcn(game.game.moveList || "");
  const remaining = (game.game.moveTimestamps || "")
    .split(",")
    .filter((s) => s.trim() !== "")
    .map(Number)
    .slice(0, moves.length);
  return { moves, remaining };
}

/** Builds an ImportedGame from board A's payload and its partner's (B). */
export function importChessComGames(a: ChessComGame, b: ChessComGame | null): ImportedGame {
  const pa = playersByColor(a);
  const pb = playersByColor(b);
  const headers = pgnHeaders(a);
  // Board A's colour of winner names the winning team: A White + B Black, or A Black + B White.
  const winnerColor = (a.game.colorOfWinner || "").toLowerCase();
  const winner = winnerColor === "white" ? "white-team" : winnerColor === "black" ? "black-team" : a.game.isFinished ? "draw" : null;
  return {
    source: "chess.com",
    ids: { A: String(a.game.id), B: b ? String(b.game.id) : null },
    players: { aWhite: pa.white, aBlack: pa.black, bWhite: pb.white, bBlack: pb.black },
    baseTime: a.game.baseTime1 || 1800,
    incrementDs: Math.round((a.game.timeIncrement1 || 0) * 10),
    boards: { A: boardSource(a), B: boardSource(b) },
    result: {
      winner,
      reason: a.game.gameEndReason || "",
      message: a.game.resultMessage || headers.Termination || "",
    },
    date: headers.Date,
    timeControl: headers.TimeControl,
  };
}

/** Extracts a game id from a chess.com URL or a bare id. */
export function parseChessComId(input: string): string | null {
  const text = input.trim();
  if (/^\d{6,}$/.test(text)) return text;
  const match = text.match(/chess\.com\/(?:[a-z]{2}\/)?(?:game\/)?(?:live\/)?(?:game\/)?(\d{6,})/i)
    ?? text.match(/(?:live|game)\/(?:live\/)?(\d{6,})/i)
    ?? text.match(/[?&](?:gameId|id)=(\d{6,})/i);
  if (match) return match[1];
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0] : null;
}
