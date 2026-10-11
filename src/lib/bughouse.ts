// Bughouse rules on top of chessops' crazyhouse positions.
//
// Each board is a crazyhouse position whose pocket for a colour is that
// player's reserve. chessops credits a capture to the capturer's own pocket;
// in bughouse the piece goes to the capturer's partner, who plays the other
// colour on the other board, so every capture is moved across afterwards.
// Promoted pieces are tracked by chessops and revert to pawns when captured.

import { Crazyhouse } from "chessops/variant";
import { makeFen, parseFen, INITIAL_FEN } from "chessops/fen";
import { parseUci, makeSquare, opposite, parseSquare } from "chessops/util";
import { normalizeMove } from "chessops/chess";
import { makeSan } from "chessops/san";
import { Material } from "chessops/setup";
import type { Move, Role, Color, Square } from "chessops/types";

export type BoardId = "A" | "B";
export type TeamId = "white" | "black";

export const BOARDS: BoardId[] = ["A", "B"];
export const POCKET_ROLES: Role[] = ["pawn", "knight", "bishop", "rook", "queen"];

/** Team "white" is White on A and Black on B; team "black" the other two. */
export function teamOf(board: BoardId, color: Color): TeamId {
  return (board === "A") === (color === "white") ? "white" : "black";
}

export function colorOf(board: BoardId, team: TeamId): Color {
  return (board === "A") === (team === "white") ? "white" : "black";
}

export function otherBoard(board: BoardId): BoardId {
  return board === "A" ? "B" : "A";
}

export function otherTeam(team: TeamId): TeamId {
  return team === "white" ? "black" : "white";
}

export interface PlayedMove {
  board: BoardId;
  color: Color;
  /** Standard UCI: castling as e1g1, drops as N@f3. */
  uci: string;
  san: string;
  captured?: Role;
}

function parseCrazyhouse(fen: string): Crazyhouse {
  const setup = parseFen(fen.trim()).unwrap();
  if (!setup.pockets) setup.pockets = Material.empty();
  return Crazyhouse.fromSetup(setup).unwrap();
}

/** Lenient variant for user-edited positions: skips legality validation. */
function parseCrazyhouseUnchecked(fen: string): Crazyhouse {
  const setup = parseFen(fen.trim()).unwrap();
  if (!setup.pockets) setup.pockets = Material.empty();
  const pos = Crazyhouse.default();
  (pos as unknown as { setupUnchecked(s: typeof setup): void }).setupUnchecked(setup);
  return pos;
}

/** Converts chessops' king-takes-rook castling back to standard UCI. */
export function standardUci(pos: Crazyhouse, move: Move): string {
  if ("from" in move) {
    const king = pos.board.get(move.from);
    if (king?.role === "king" && pos.board.get(move.to)?.role === "rook" && pos.board.get(move.to)?.color === king.color) {
      const rank = move.from >> 3;
      const file = move.to > move.from ? 6 : 2;
      return makeSquare(move.from) + makeSquare(rank * 8 + file);
    }
    return makeSquare(move.from) + makeSquare(move.to) + (move.promotion ? roleChar(move.promotion) : "");
  }
  return `${roleChar(move.role).toUpperCase()}@${makeSquare(move.to)}`;
}

function roleChar(role: Role): string {
  return { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" }[role];
}

export class BughousePosition {
  a: Crazyhouse;
  b: Crazyhouse;

  constructor(a: Crazyhouse, b: Crazyhouse) {
    this.a = a;
    this.b = b;
  }

  static initial(): BughousePosition {
    return new BughousePosition(parseCrazyhouse(INITIAL_FEN), parseCrazyhouse(INITIAL_FEN));
  }

  static fromFens(fenA: string, fenB: string, validate = true): BughousePosition {
    const parse = validate ? parseCrazyhouse : parseCrazyhouseUnchecked;
    return new BughousePosition(parse(fenA), parse(fenB));
  }

  /** Accepts "fenA | fenB" as the engine prints it. */
  static fromDualFen(dual: string, validate = true): BughousePosition {
    const [fa, fb] = dual.split("|");
    if (!fb) throw new Error("expected two FENs separated by |");
    return BughousePosition.fromFens(fa, fb, validate);
  }

  clone(): BughousePosition {
    return new BughousePosition(this.a.clone(), this.b.clone());
  }

  board(id: BoardId): Crazyhouse {
    return id === "A" ? this.a : this.b;
  }

  fen(id: BoardId): string {
    return makeFen(this.board(id).toSetup());
  }

  dualFen(): string {
    return `${this.fen("A")} | ${this.fen("B")}`;
  }

  turn(id: BoardId): Color {
    return this.board(id).turn;
  }

  /** Team on turn on a board. */
  teamToMove(id: BoardId): TeamId {
    return teamOf(id, this.turn(id));
  }

  parseMove(id: BoardId, uci: string): Move | undefined {
    const move = parseUci(uci);
    if (!move) return undefined;
    return normalizeMove(this.board(id), move);
  }

  isLegal(id: BoardId, uci: string): boolean {
    const move = this.parseMove(id, uci);
    return !!move && this.board(id).isLegal(move);
  }

  /** Plays a move in place. Throws if it is illegal. */
  play(id: BoardId, uci: string): PlayedMove {
    const pos = this.board(id);
    const move = this.parseMove(id, uci);
    if (!move || !pos.isLegal(move)) {
      throw new Error(`illegal move ${uci} on board ${id} (${this.fen(id)})`);
    }
    const color = pos.turn;
    // chessops writes pawn drops as "@e4"; bughouse players write "P@e4".
    const rawSan = makeSan(pos, move);
    const san = rawSan.startsWith("@") ? `P${rawSan}` : rawSan;
    const standard = standardUci(pos, move);
    const before = pos.pockets!.clone();
    pos.play(move);
    let captured: Role | undefined;
    const after = pos.pockets!;
    for (const role of POCKET_ROLES) {
      if (after[color][role] > before[color][role]) {
        captured = role;
        after[color][role]--;
        this.board(otherBoard(id)).pockets![opposite(color)][role]++;
      }
    }
    return { board: id, color, uci: standard, san, captured };
  }

  pocket(id: BoardId, color: Color): Record<Role, number> {
    const p = this.board(id).pockets![color];
    return { pawn: p.pawn, knight: p.knight, bishop: p.bishop, rook: p.rook, queen: p.queen, king: 0 };
  }

  setPocket(id: BoardId, color: Color, role: Role, count: number) {
    this.board(id).pockets![color][role] = Math.max(0, count);
  }

  isCheck(id: BoardId): boolean {
    return this.board(id).isCheck();
  }

  /**
   * Bughouse mate: the side to move is in check and could not escape even if
   * the partner sent any piece, i.e. no drop could ever block it.
   */
  isMate(id: BoardId): boolean {
    const pos = this.board(id);
    if (!pos.isCheck()) return false;
    if (!pos.isCheckmate()) return false;
    const probe = pos.clone();
    for (const role of POCKET_ROLES) probe.pockets![probe.turn][role] = Math.max(1, probe.pockets![probe.turn][role]);
    return probe.isCheckmate();
  }

  legalDests(id: BoardId): Map<string, string[]> {
    const pos = this.board(id);
    const dests = new Map<string, string[]>();
    const ctx = pos.ctx();
    for (const [from, squares] of pos.allDests(ctx)) {
      const list: string[] = [];
      for (const to of squares) {
        list.push(makeSquare(to));
        // Offer the standard king destination for castling as well.
        const piece = pos.board.get(from);
        const target = pos.board.get(to);
        if (piece?.role === "king" && target?.role === "rook" && target.color === piece.color) {
          const rank = from >> 3;
          list.push(makeSquare(rank * 8 + (to > from ? 6 : 2)));
        }
      }
      if (list.length) dests.set(makeSquare(from), list);
    }
    return dests;
  }

  /** Squares where `role` may be dropped right now (ignoring pocket contents). */
  dropDests(id: BoardId, role: Role): string[] {
    const pos = this.board(id).clone();
    pos.pockets![pos.turn][role] = Math.max(1, pos.pockets![pos.turn][role]);
    const squares: string[] = [];
    for (let sq = 0 as Square; sq < 64; sq++) {
      if (pos.isLegal({ role, to: sq })) squares.push(makeSquare(sq));
    }
    return squares;
  }
}

export function squareIndex(name: string): number {
  return parseSquare(name) ?? -1;
}

/** Bughouse-flavoured piece values for a material count. */
export const PIECE_VALUES: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
