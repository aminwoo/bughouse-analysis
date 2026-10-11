// Display helpers: engine lines as SAN, values as percentages, arrows.

import type { DrawShape } from "chessground/draw";
import type { Key, Role } from "chessground/types";
import { colorOf, otherTeam, type BoardId, type BughousePosition, type TeamId } from "./bughouse";
import type { JointMove } from "../engine/engineClient";

export interface PvStep {
  team: TeamId;
  a: string | null; // SAN, "sit", or null when that board is not the team's turn
  b: string | null;
}

/** Converts a joint-move PV to SAN, alternating teams starting with `team`. */
export function pvToSan(start: BughousePosition, pv: JointMove[], team: TeamId, maxSteps = 12): PvStep[] {
  const pos = start.clone();
  const steps: PvStep[] = [];
  let acting = team;
  for (const joint of pv.slice(0, maxSteps)) {
    const step: PvStep = { team: acting, a: null, b: null };
    let ok = true;
    for (const board of ["A", "B"] as BoardId[]) {
      const uci = board === "A" ? joint.a : joint.b;
      const onTurn = pos.turn(board) === colorOf(board, acting);
      if (!uci) {
        step[board === "A" ? "a" : "b"] = onTurn ? "sit" : null;
        continue;
      }
      try {
        step[board === "A" ? "a" : "b"] = pos.play(board, uci).san;
      } catch {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    steps.push(step);
    acting = otherTeam(acting);
  }
  return steps;
}

/** SAN for one move on one board, or null if it does not parse. */
export function sanFor(position: BughousePosition, board: BoardId, uci: string): string | null {
  try {
    return position.clone().play(board, uci).san;
  } catch {
    return null;
  }
}

export function percent(value: number): string {
  return `${Math.round(50 + 50 * Math.max(-1, Math.min(1, value)))}%`;
}

/** Signed evaluation in the engine's centipawn-like scale. */
export function evalText(value: number, mate: number | null): string {
  if (mate != null && mate !== 0) return `${mate > 0 ? "+" : "-"}M${Math.abs(mate)}`;
  const cp = 180 * Math.tan(1.56 * Math.max(-0.999, Math.min(0.999, value)));
  const pawns = cp / 100;
  return `${pawns >= 0 ? "+" : ""}${Math.abs(pawns) >= 10 ? pawns.toFixed(0) : pawns.toFixed(1)}`;
}

const DROP_ROLES: Record<string, Role> = { P: "pawn", N: "knight", B: "bishop", R: "rook", Q: "queen" };

/** Arrow (or ghost piece for a drop) for a UCI move. */
export function moveShape(uci: string, color: "white" | "black", brush: string, faded = false): DrawShape {
  const drop = uci.match(/^([PNBRQ])@([a-h][1-8])$/);
  const modifiers = faded ? { lineWidth: 7 } : undefined;
  if (drop) {
    return { orig: drop[2] as Key, brush, piece: { role: DROP_ROLES[drop[1]], color, scale: 0.75 }, modifiers };
  }
  return { orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush, modifiers };
}
