import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Config } from "chessground/config";
import type { DrawShape } from "chessground/draw";
import type { Key, Piece, Role } from "chessground/types";
import { dragNewPiece } from "chessground/drag";
import { setDropMode, cancelDropMode } from "chessground/drop";
import type { BoardId, BughousePosition } from "../lib/bughouse";

export interface BoardHandle {
  startDrag: (piece: Piece, event: MouseEvent | TouchEvent) => void;
  armDrop: (piece: Piece | null) => void;
}

interface BoardProps {
  id: BoardId;
  position: BughousePosition;
  orientation: "white" | "black";
  lastMove?: string[];
  interactive: boolean;
  shapes: DrawShape[];
  onMove: (uci: string) => boolean;
  onArmedDropChange?: (piece: Piece | null) => void;
}

const PROMOTION_ROLES: Role[] = ["queen", "knight", "rook", "bishop"];
const ROLE_CHAR: Record<Role, string> = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };

export const Board = forwardRef<BoardHandle, BoardProps>(function Board(props, ref) {
  const element = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [promotion, setPromotion] = useState<{ orig: Key; dest: Key; color: "white" | "black" } | null>(null);

  const config = (): Config => {
    const p = propsRef.current;
    const board = p.position.board(p.id);
    const turn = board.turn;
    return {
      fen: p.position.fen(p.id).split(" ")[0].replace(/\[.*\]/, ""),
      orientation: p.orientation,
      turnColor: turn,
      check: board.isCheck() ? turn : false,
      lastMove: p.lastMove as Key[] | undefined,
      coordinates: true,
      autoCastle: true,
      movable: {
        free: false,
        color: p.interactive ? turn : undefined,
        dests: p.interactive ? (p.position.legalDests(p.id) as Map<Key, Key[]>) : new Map(),
        showDests: true,
        events: {
          after: (orig, dest) => onUserMove(orig, dest),
          afterNewPiece: (role, key) => onUserDrop(role, key),
        },
      },
      premovable: { enabled: false },
      predroppable: { enabled: false },
      draggable: { enabled: p.interactive, showGhost: true },
      selectable: { enabled: p.interactive },
      animation: { enabled: true, duration: 160 },
      drawable: { enabled: true, visible: true, autoShapes: p.shapes, eraseOnClick: true },
      highlight: { lastMove: true, check: true },
    };
  };

  const resync = () => api.current?.set(config());

  const onUserMove = (orig: Key, dest: Key) => {
    const p = propsRef.current;
    const piece = p.position.board(p.id).board.get(squareIndex(orig));
    const rank = dest[1];
    if (piece?.role === "pawn" && (rank === "8" || rank === "1")) {
      setPromotion({ orig, dest, color: piece.color });
      return;
    }
    if (!p.onMove(orig + dest)) resync();
  };

  const onUserDrop = (role: Role, key: Key) => {
    const p = propsRef.current;
    p.onArmedDropChange?.(null);
    if (api.current) cancelDropMode(api.current.state);
    if (!p.onMove(`${ROLE_CHAR[role].toUpperCase()}@${key}`)) resync();
  };

  useEffect(() => {
    if (!element.current) return;
    api.current = Chessground(element.current, config());
    // chessground caches its bounds; redraw when the layout resizes the board.
    const observer = new ResizeObserver(() => api.current?.redrawAll());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      api.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    resync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.position, props.orientation, props.lastMove?.join(), props.interactive]);

  useEffect(() => {
    api.current?.setAutoShapes(props.shapes);
  }, [props.shapes]);

  useImperativeHandle(ref, () => ({
    startDrag: (piece, event) => {
      if (api.current) dragNewPiece(api.current.state, piece, event);
    },
    armDrop: (piece) => {
      if (!api.current) return;
      if (piece) setDropMode(api.current.state, piece);
      else cancelDropMode(api.current.state);
      api.current.state.dom.redraw();
    },
  }));

  const pick = (role: Role | null) => {
    const pending = promotion;
    setPromotion(null);
    if (pending && role && propsRef.current.onMove(pending.orig + pending.dest + ROLE_CHAR[role])) return;
    resync();
  };

  return (
    <div className="board-frame">
      <div ref={element} className="board" />
      {promotion && (
        <div className="promotion" onClick={() => pick(null)}>
          <div className="promotion-choices" onClick={(e) => e.stopPropagation()}>
            {PROMOTION_ROLES.map((role) => (
              <button key={role} className="promotion-choice" onClick={() => pick(role)} aria-label={`Promote to ${role}`}>
                <span className={`piece ${promotion.color} ${role}`} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

function squareIndex(key: string): number {
  return (key.charCodeAt(0) - 97) + 8 * (Number(key[1]) - 1);
}
