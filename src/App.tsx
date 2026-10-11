import { useCallback, useEffect, useMemo, useState } from "react";
import type { DrawShape } from "chessground/draw";
import { useStore } from "./state/store";
import { summarizeLive, useCursorClocks, useCursorValue, useLastMoves, useReviews } from "./state/derived";
import { Header } from "./components/Header";
import { BoardView } from "./components/BoardView";
import { EvalBar } from "./components/EvalBar";
import { EnginePanel, teamNames } from "./components/EnginePanel";
import { MoveList } from "./components/MoveList";
import { EvalGraph } from "./components/EvalGraph";
import { ReviewPanel } from "./components/ReviewPanel";
import { SetupModal } from "./components/SetupModal";
import { AboutModal, SettingsModal } from "./components/Dialogs";
import { colorOf, otherTeam, type BoardId } from "./lib/bughouse";
import { getNode } from "./lib/tree";
import { buildFromSetup } from "./lib/game";
import { importFromChessCom } from "./lib/importer";
import { moveShape, sanFor } from "./lib/format";
import { JUDGEMENTS } from "./lib/review";
import { loadCachedReview } from "./engine/service";

type Dialog = "setup" | "settings" | "about" | null;

async function loadReviewCache(gameKey: string) {
  const cached = await loadCachedReview(gameKey);
  const state = useStore.getState();
  if (cached && state.game.key === gameKey && !state.review.running) {
    state.setEvals(cached.evals);
    state.setReview({ nodes: cached.nodes, network: cached.network, done: cached.evals.filter(Boolean).length, total: state.tree.mainline.length });
  }
}

function setUrl(params: Record<string, string> | null) {
  const url = new URL(location.href);
  url.search = params ? new URLSearchParams(params).toString() : "";
  history.replaceState(null, "", url);
}

export function App() {
  const [dialog, setDialog] = useState<Dialog>(null);
  const game = useStore((s) => s.game);
  const tree = useStore((s) => s.tree);
  const cursor = useStore((s) => s.cursor);
  const flipped = useStore((s) => s.flipped);
  const live = useStore((s) => s.live);
  const settings = useStore((s) => s.settings);
  const error = useStore((s) => s.error);
  const loading = useStore((s) => s.loading);
  const play = useStore((s) => s.play);
  const reviews = useReviews();
  const value = useCursorValue();
  const lastMoves = useLastMoves();
  const clocks = useCursorClocks();
  const node = getNode(tree, cursor);

  const importGame = useCallback(async (input: string, ply?: number) => {
    const { setLoading, setError, loadGame } = useStore.getState();
    setError(null);
    setLoading("Fetching game…");
    try {
      const record = await importFromChessCom(input, (text) => setLoading(text));
      loadGame(record, [], ply);
      setUrl({ game: record.source!.ids.A });
      void loadReviewCache(record.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }, []);

  // Open a game or position from the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const gameId = params.get("game") ?? params.get("gameId");
    const fen = params.get("fen");
    if (gameId) void importGame(gameId, params.has("ply") ? Number(params.get("ply")) : undefined);
    else if (fen && fen.includes("|")) {
      const [a, b] = fen.split("|").map((s) => s.trim());
      try {
        useStore.getState().loadGame(buildFromSetup(a, b, null));
      } catch {
        useStore.getState().setError("The position in the link is not valid.");
      }
    }
  }, [importGame]);

  // Keep the mainline move in the link so it can be shared.
  useEffect(() => {
    if (!game.source || !node.mainline) return;
    const timer = setTimeout(() => setUrl(node.ply ? { game: game.source!.ids.A, ply: String(node.ply) } : { game: game.source!.ids.A }), 300);
    return () => clearTimeout(timer);
  }, [game, node]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest("select, textarea, [contenteditable]") || (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio");
      if (typing || dialog) return;
      const s = useStore.getState();
      if (e.key === "ArrowLeft") s.prev();
      else if (e.key === "ArrowRight") s.next();
      else if (e.key === "ArrowUp") s.first();
      else if (e.key === "ArrowDown") s.last();
      else if (e.key === "f") s.toggleFlip();
      else if (e.key === " ") s.setLive({ enabled: !s.live.enabled });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  // Arrows: the live engine's joint move, else the review's suggestion.
  const shapes = useMemo(() => {
    const out: Record<BoardId, DrawShape[]> = { A: [], B: [] };
    if (!settings.arrows) return out;
    const liveLines = summarizeLive(live).lines;
    if (live.enabled && live.nodeId === cursor && liveLines.length && live.searchedTeam) {
      liveLines.forEach((line, index) => {
        const first = line.pv[0];
        if (!first) return;
        const brush = index === 0 ? "green" : "paleGreen";
        if (first.a) out.A.push(moveShape(first.a, colorOf("A", live.searchedTeam!), brush, index > 0));
        if (first.b) out.B.push(moveShape(first.b, colorOf("B", live.searchedTeam!), brush, index > 0));
      });
      return out;
    }
    // After a flagged move, show what the engine preferred instead.
    if (node.mainline) {
      const review = reviews[node.ply];
      if (review?.judgement && review.best) {
        out[review.board].push(moveShape(review.best, colorOf(review.board, review.team), "blue"));
      }
    }
    return out;
  }, [settings.arrows, live, cursor, node, reviews]);

  const comment = useMemo(() => {
    if (!node.mainline || !node.move) return null;
    const review = reviews[node.ply];
    if (!review) return null;
    const parent = getNode(tree, node.parent!);
    const j = JUDGEMENTS.find((x) => x.name === review.judgement);
    const best =
      review.best === undefined ? null : review.best === null ? "sitting" : sanFor(parent.position, review.board, review.best) ?? review.best;
    return { review, judgement: j, best, san: node.move.san };
  }, [node, reviews, tree]);

  const orientations = { A: flipped ? "black" : "white", B: flipped ? "white" : "black" } as const;
  const players = {
    A: { white: game.players.aWhite, black: game.players.aBlack },
    B: { white: game.players.bWhite, black: game.players.bBlack },
  };
  const boardLeft: BoardId = "A";
  const boardRight: BoardId = "B";

  const onMove = (board: BoardId) => (uci: string) => play(board, uci);

  return (
    <div className="app">
      <Header onImport={(input) => void importGame(input)} onSetup={() => setDialog("setup")} onSettings={() => setDialog("settings")} onAbout={() => setDialog("about")} />
      {(error || loading) && (
        <div className={`banner ${error ? "error" : ""}`}>
          {error ?? loading}
          {error && (
            <button className="btn ghost small" onClick={() => useStore.getState().setError(null)}>
              Dismiss
            </button>
          )}
        </div>
      )}
      <main className="layout">
        <div className="boards-column">
          <div className="game-title">
            <span className="team-label team-white" title="A White and B Black">
              {teamNames(game, "white")}
            </span>
            <span className="vs">vs</span>
            <span className="team-label team-black" title="A Black and B White">
              {teamNames(game, otherTeam("white"))}
            </span>
            {game.date && <span className="muted small game-meta">{game.date.replace(/\./g, "-")}</span>}
          </div>
          <div className="boards">
            <BoardView
              id={boardLeft}
              position={node.position}
              orientation={orientations[boardLeft]}
              players={players[boardLeft]}
              clocks={clocks}
              lastMove={lastMoves[boardLeft]}
              shapes={shapes[boardLeft]}
              onMove={onMove(boardLeft)}
            />
            <EvalBar value={value} flipped={flipped} label="White team (A White + B Black) winning chances" />
            <BoardView
              id={boardRight}
              position={node.position}
              orientation={orientations[boardRight]}
              players={players[boardRight]}
              clocks={clocks}
              lastMove={lastMoves[boardRight]}
              shapes={shapes[boardRight]}
              onMove={onMove(boardRight)}
            />
          </div>
          <Controls />
          {comment && (
            <div className={`comment ${comment.judgement ? `j-${comment.judgement.name}` : ""}`}>
              <strong>
                {comment.review.board} {comment.san}
                {comment.judgement?.glyph}
              </strong>{" "}
              {comment.judgement ? `${capitalize(comment.judgement.name)}.` : "Good move."}
              {comment.judgement && comment.best && ` Better was ${comment.best}.`}
              <span className="muted small">
                {" "}
                {Math.round(50 + 50 * comment.review.before)}% → {Math.round(50 + 50 * comment.review.after)}% for {teamNames(game, comment.review.team)}
              </span>
            </div>
          )}
        </div>
        <aside className="side-column">
          <EnginePanel />
          <ReviewPanel />
          <EvalGraph />
          <MoveList />
        </aside>
      </main>
      {dialog === "setup" && (
        <SetupModal
          initial={{ A: node.position.fen("A"), B: node.position.fen("B") }}
          onCancel={() => setDialog(null)}
          onSubmit={(a, b, startClocks) => {
            useStore.getState().loadGame(buildFromSetup(a, b, startClocks));
            setUrl({ fen: `${a}|${b}` });
            setDialog(null);
          }}
        />
      )}
      {dialog === "settings" && <SettingsModal onClose={() => setDialog(null)} />}
      {dialog === "about" && <AboutModal onClose={() => setDialog(null)} />}
    </div>
  );
}

function capitalize(s: string) {
  return s[0].toUpperCase() + s.slice(1);
}

function Controls() {
  const s = useStore();
  const node = getNode(s.tree, s.cursor);
  return (
    <div className="controls">
      <button className="btn icon" onClick={s.first} disabled={!node.parent} aria-label="First move" title="Start (↑)">
        ⏮
      </button>
      <button className="btn icon" onClick={s.prev} disabled={!node.parent} aria-label="Previous move" title="Previous (←)">
        ◀
      </button>
      <button className="btn icon" onClick={s.next} disabled={!node.children.length} aria-label="Next move" title="Next (→)">
        ▶
      </button>
      <button className="btn icon" onClick={s.last} disabled={!node.children.length} aria-label="Last move" title="End (↓)">
        ⏭
      </button>
      <button className="btn icon" onClick={s.toggleFlip} aria-label="Flip boards" title="Flip (f)">
        ⇅
      </button>
    </div>
  );
}
