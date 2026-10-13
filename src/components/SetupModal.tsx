import { useEffect, useMemo, useRef, useState } from "react";
import { Chessground } from "chessground";
import type { Api } from "chessground/api";
import type { Key, Piece, Role } from "chessground/types";
import { parseFen, makeFen, INITIAL_FEN, EMPTY_FEN } from "chessops/fen";
import { Crazyhouse } from "chessops/variant";
import { Material } from "chessops/setup";
import { POCKET_ROLES, type BoardId } from "../lib/bughouse";
import type { Clocks } from "../lib/game";

interface SetupModalProps {
  initial: { A: string; B: string };
  onCancel: () => void;
  onSubmit: (fenA: string, fenB: string, clocks: Clocks | null) => void;
}

type Tool = Piece | "erase" | null;

const ROLES: Role[] = ["king", "queen", "rook", "bishop", "knight", "pawn"];
const BASE = 1800;

/** Validates a crazyhouse FEN; returns an error message or null. */
function validate(fen: string): string | null {
  const setup = parseFen(fen);
  if (setup.isErr) return "Malformed FEN";
  const s = setup.unwrap();
  if (!s.pockets) s.pockets = Material.empty();
  const pos = Crazyhouse.fromSetup(s);
  if (pos.isErr) {
    const msg = String(pos.error.message || pos.error);
    if (/kings/i.test(msg)) return "Each side needs exactly one king";
    if (/pawns/i.test(msg)) return "Pawns cannot stand on the first or last rank";
    if (/check/i.test(msg)) return "The side not to move is in check";
    return msg;
  }
  return null;
}

/** Round-trips a valid FEN through chessops to drop impossible castling rights. */
function normalize(fen: string): string {
  const s = parseFen(fen).unwrap();
  if (!s.pockets) s.pockets = Material.empty();
  return makeFen(Crazyhouse.fromSetup(s).unwrap().toSetup());
}

function BoardEditor({ id, fen, onChange, orientation }: { id: BoardId; fen: string; onChange: (fen: string) => void; orientation: "white" | "black" }) {
  const element = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const toolRef = useRef<Tool>(null);
  toolRef.current = tool;
  const fenRef = useRef(fen);
  fenRef.current = fen;

  const setup = useMemo(() => {
    const parsed = parseFen(fen);
    return parsed.isOk ? parsed.unwrap() : null;
  }, [fen]);

  // Rebuild the FEN from the editor board while keeping turn, pockets, etc.
  const commitBoard = () => {
    if (!api.current) return;
    const placement = api.current.getFen();
    const parsed = parseFen(fenRef.current);
    const current = parsed.isOk ? parsed.unwrap() : parseFen(EMPTY_FEN).unwrap();
    const next = parseFen(`${placement} w - - 0 1`).unwrap();
    current.board = next.board;
    current.castlingRights = current.castlingRights.intersect(next.board.rook);
    current.epSquare = undefined;
    onChange(makeFen(current));
  };

  useEffect(() => {
    if (!element.current) return;
    api.current = Chessground(element.current, {
      fen: fen.split(" ")[0].replace(/\[.*\]/, ""),
      orientation,
      movable: { free: true, color: "both", showDests: false },
      draggable: { deleteOnDropOff: true },
      animation: { enabled: false },
      highlight: { lastMove: false, check: false },
      premovable: { enabled: false },
      events: {
        change: () => commitBoard(),
        select: (key: Key) => {
          const t = toolRef.current;
          if (!t || !api.current) return;
          const pieces = new Map<Key, Piece | undefined>();
          pieces.set(key, t === "erase" ? undefined : t);
          api.current.setPieces(pieces);
          api.current.selectSquare(null);
          commitBoard();
        },
      },
    });
    const observer = new ResizeObserver(() => api.current?.redrawAll());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      api.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const placement = fen.split(" ")[0].replace(/\[.*\]/, "");
    if (api.current && api.current.getFen() !== placement.replace(/~/g, "")) api.current.set({ fen: placement });
  }, [fen]);

  useEffect(() => {
    api.current?.set({ orientation });
  }, [orientation]);

  const update = (mutate: (s: NonNullable<typeof setup>) => void) => {
    if (!setup) return;
    const next = parseFen(makeFen(setup)).unwrap();
    if (!next.pockets) next.pockets = Material.empty();
    mutate(next);
    onChange(makeFen(next));
  };

  const error = validate(fen);
  return (
    <div className="editor">
      <div className="editor-title">Board {id}</div>
      <div className="editor-palette">
        {(["white", "black"] as const).map((color) => (
          <div key={color} className="palette-row">
            {ROLES.map((role) => {
              const on = tool !== "erase" && tool?.role === role && tool.color === color;
              return (
                <button key={role} className={`palette-piece ${on ? "on" : ""}`} onClick={() => setTool(on ? null : { role, color })} aria-label={`Place ${color} ${role}`}>
                  <span className={`piece ${color} ${role}`} />
                </button>
              );
            })}
          </div>
        ))}
        <button className={`btn small ${tool === "erase" ? "on" : ""}`} onClick={() => setTool(tool === "erase" ? null : "erase")}>
          Erase
        </button>
      </div>
      <div className="editor-board">
        <div ref={element} className="board" />
      </div>
      {setup && (
        <div className="editor-fields">
          <div className="segmented">
            {(["white", "black"] as const).map((c) => (
              <button key={c} className={setup.turn === c ? "on" : ""} onClick={() => update((s) => (s.turn = c))}>
                {c === "white" ? "White" : "Black"} to move
              </button>
            ))}
          </div>
          {(["white", "black"] as const).map((color) => (
            <div key={color} className="pocket-editor">
              <span className="small muted">{color === "white" ? "White" : "Black"} reserve</span>
              {POCKET_ROLES.map((role) => (
                <span key={role} className="pocket-edit">
                  <span className={`piece ${color} ${role}`} />
                  <button onClick={() => update((s) => (s.pockets![color][role] = Math.max(0, s.pockets![color][role] - 1)))} aria-label={`Remove ${color} ${role}`}>
                    −
                  </button>
                  <span>{setup.pockets?.[color][role] ?? 0}</span>
                  <button onClick={() => update((s) => s.pockets![color][role]++)} aria-label={`Add ${color} ${role}`}>
                    +
                  </button>
                </span>
              ))}
            </div>
          ))}
          <div className="editor-row">
            <button className="btn small" onClick={() => onChange(INITIAL_FEN.replace(" w ", "[] w "))}>
              Start position
            </button>
            <button className="btn small" onClick={() => onChange("4k3/8/8/8/8/8/8/4K3[] w - - 0 1")}>
              Kings only
            </button>
          </div>
        </div>
      )}
      <input className={`fen-input ${error ? "invalid" : ""}`} value={fen} onChange={(e) => onChange(e.target.value)} spellCheck={false} aria-label={`Board ${id} FEN`} />
      {error && <div className="error-text small">{error}</div>}
    </div>
  );
}

export function SetupModal({ initial, onCancel, onSubmit }: SetupModalProps) {
  const [fenA, setFenA] = useState(initial.A);
  const [fenB, setFenB] = useState(initial.B);
  // Seconds the white team (A White & B Black) leads its diagonal opponents by.
  const [lead, setLead] = useState("0");
  const leadSeconds = Number(lead);
  const valid = !validate(fenA) && !validate(fenB) && lead.trim() !== "" && Number.isFinite(leadSeconds) && Math.abs(leadSeconds) <= BASE / 10;

  const clocks = (): Clocks => {
    // Team white leads when A White's clock exceeds B White's, by the same
    // amount as B Black's exceeds A Black's.
    const half = Math.round(leadSeconds * 5);
    return {
      A: { white: BASE + half, black: BASE - half },
      B: { white: BASE - half, black: BASE + half },
    };
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Set up position">
        <header className="modal-header">
          <h2>Set up position</h2>
          <button className="btn ghost icon" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </header>
        <p className="muted small">
          Board B is shown from Black's side, as it would be next to board A. Click a palette piece then squares to place it; drag pieces off the board to remove them.
        </p>
        <div className="editors">
          <BoardEditor id="A" fen={fenA} onChange={setFenA} orientation="white" />
          <BoardEditor id="B" fen={fenB} onChange={setFenB} orientation="black" />
        </div>
        <div className="editor-footer">
          <label className="field" title="Negative when A Black & B White are ahead. The leading team may sit until its lead is spent.">
            <span>A White &amp; B Black lead on time (seconds)</span>
            <input type="number" step="0.5" value={lead} onChange={(e) => setLead(e.target.value)} />
          </label>
          <div className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => onSubmit(normalize(fenA), normalize(fenB), clocks())}>
            Analyze position
          </button>
        </div>
      </div>
    </div>
  );
}
