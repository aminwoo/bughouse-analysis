import { useRef, useState } from "react";
import type { DrawShape } from "chessground/draw";
import type { Piece, Role } from "chessground/types";
import { Board, type BoardHandle } from "./Board";
import { POCKET_ROLES, type BoardId, type BughousePosition } from "../lib/bughouse";
import type { PlayerInfo } from "../lib/chesscom";
import type { Clocks } from "../lib/game";

interface Seat {
  color: "white" | "black";
  player: PlayerInfo;
  clock: number | null;
}

interface BoardViewProps {
  id: BoardId;
  position: BughousePosition;
  orientation: "white" | "black";
  players: { white: PlayerInfo; black: PlayerInfo };
  clocks: Clocks | null;
  lastMove?: string[];
  shapes: DrawShape[];
  onMove: (uci: string) => boolean;
}

export function formatClock(ds: number | null): string {
  if (ds == null) return "";
  const total = Math.max(0, ds);
  const minutes = Math.floor(total / 600);
  const seconds = Math.floor((total % 600) / 10);
  const tenths = total % 10;
  return total < 200 ? `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function BoardView(props: BoardViewProps) {
  const board = useRef<BoardHandle>(null);
  const [armed, setArmed] = useState<Piece | null>(null);
  const turn = props.position.turn(props.id);
  const seat = (color: "white" | "black"): Seat => ({
    color,
    player: props.players[color],
    clock: props.clocks ? props.clocks[props.id][color] : null,
  });
  const top = seat(props.orientation === "white" ? "black" : "white");
  const bottom = seat(props.orientation);

  const arm = (piece: Piece | null) => {
    setArmed(piece);
    board.current?.armDrop(piece);
  };

  const bar = (s: Seat, placement: "top" | "bottom") => {
    const pocket = props.position.pocket(props.id, s.color);
    const toMove = turn === s.color;
    const opponentClock = props.clocks ? props.clocks[props.id][s.color === "white" ? "black" : "white"] : null;
    const behind = s.clock != null && opponentClock != null && s.clock < opponentClock;
    return (
      <div className={`player-bar ${placement} ${toMove ? "to-move" : ""}`}>
        <div className="player-name">
          {s.player.title && <span className="title-badge">{s.player.title}</span>}
          <span className="username">{s.player.username}</span>
          {s.player.rating != null && <span className="rating">{s.player.rating}</span>}
        </div>
        <div className="pocket" aria-label={`${s.player.username}'s reserve`}>
          {POCKET_ROLES.map((role) => {
            const count = pocket[role];
            const usable = toMove && count > 0;
            const isArmed = armed?.role === role && armed.color === s.color;
            return (
              <span
                key={role}
                className={`pocket-piece ${count ? "" : "empty"} ${usable ? "usable" : ""} ${isArmed ? "armed" : ""}`}
                title={usable ? `Drop ${role} (click, then click a square; or drag)` : undefined}
                onMouseDown={(e) => {
                  if (!usable || e.button !== 0) return;
                  board.current?.startDrag({ role: role as Role, color: s.color }, e.nativeEvent);
                }}
                onTouchStart={(e) => {
                  if (usable) board.current?.startDrag({ role: role as Role, color: s.color }, e.nativeEvent);
                }}
                onClick={() => usable && arm(isArmed ? null : { role: role as Role, color: s.color })}
              >
                <span className={`piece ${s.color} ${role}`} />
                {count > 1 && <span className="pocket-count">{count}</span>}
              </span>
            );
          })}
        </div>
        <div className={`clock ${toMove ? "running" : ""} ${behind ? "behind" : ""}`}>{formatClock(s.clock)}</div>
      </div>
    );
  };

  return (
    <div className={`board-view board-${props.id}`}>
      {bar(top, "top")}
      <Board
        ref={board}
        id={props.id}
        position={props.position}
        orientation={props.orientation}
        lastMove={props.lastMove}
        interactive
        shapes={props.shapes}
        onMove={(uci) => {
          setArmed(null);
          return props.onMove(uci);
        }}
        onArmedDropChange={setArmed}
      />
      {bar(bottom, "bottom")}
    </div>
  );
}
