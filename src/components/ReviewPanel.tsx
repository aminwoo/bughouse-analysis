import { useStore, REVIEW_NODES, type ReviewDepth } from "../state/store";
import { useReviews, useSummary } from "../state/derived";
import { startReview, stopReview } from "../engine/service";
import { teamOf } from "../lib/bughouse";

const DEPTHS: { value: ReviewDepth; label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "normal", label: "Normal" },
  { value: "deep", label: "Deep" },
];

export function ReviewPanel() {
  const review = useStore((s) => s.review);
  const game = useStore((s) => s.game);
  const settings = useStore((s) => s.settings);
  const engine = useStore((s) => s.engine);
  const setSettings = useStore((s) => s.setSettings);
  const goto = useStore((s) => s.goto);
  const tree = useStore((s) => s.tree);
  const summary = useSummary();
  const reviews = useReviews();
  const hasMoves = game.moves.length > 0;
  const complete = review.total > 0 && review.done >= review.total;
  const backend = engine.info?.backend ?? (settings.backend === "wasm" ? "wasm" : "webgpu");
  const nodes = REVIEW_NODES[backend][settings.depth];

  const playerName = (board: "A" | "B", color: "white" | "black") =>
    game.players[`${board === "A" ? "a" : "b"}${color === "white" ? "White" : "Black"}` as keyof typeof game.players].username;

  const jumpTo = (board: "A" | "B", color: "white" | "black", judgement: "inaccuracy" | "mistake" | "blunder") => {
    const cursorPly = tree.nodes.get(useStore.getState().cursor)?.ply ?? 0;
    const matches = reviews.filter((r) => r && r.judgement === judgement && game.moves[r.ply - 1].board === board && game.moves[r.ply - 1].color === color);
    if (!matches.length) return;
    const next = matches.find((r) => r!.ply > cursorPly) ?? matches[0];
    goto(tree.mainline[next!.ply]);
  };

  return (
    <section className="panel review-panel">
      <div className="review-controls">
        {review.running ? (
          <>
            <div className="progress">
              <div style={{ width: `${review.total ? (review.done / review.total) * 100 : 0}%` }} />
            </div>
            <span className="small muted">
              {review.done}/{review.total}
            </span>
            <button className="btn" onClick={stopReview}>
              Stop
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" disabled={!hasMoves} onClick={() => void startReview()}>
              {complete ? "Re-run review" : review.done > 0 ? "Continue review" : "Review game"}
            </button>
            <div className="segmented" role="radiogroup" aria-label="Review depth">
              {DEPTHS.map((d) => (
                <button key={d.value} role="radio" aria-checked={settings.depth === d.value} className={settings.depth === d.value ? "on" : ""} onClick={() => setSettings({ depth: d.value })}>
                  {d.label}
                </button>
              ))}
            </div>
            <span className="small muted" title="Nodes searched per position, twice (with and without time advantage)">
              {nodes.toLocaleString()} nodes
            </span>
          </>
        )}
      </div>
      {review.error && <p className="error-text small">{review.error}</p>}
      {review.done > 0 && (
        <table className="summary">
          <thead>
            <tr>
              <th>Player</th>
              <th title="Average accuracy">Acc.</th>
              <th className="j-inaccuracy" title="Inaccuracies">
                ?!
              </th>
              <th className="j-mistake" title="Mistakes">
                ?
              </th>
              <th className="j-blunder" title="Blunders">
                ??
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={`${s.board}${s.color}`} className={`team-${teamOf(s.board, s.color)}`}>
                <td>
                  <span className={`seat-dot ${s.color}`} />
                  <span className="seat-board">{s.board}</span>
                  {playerName(s.board, s.color)}
                </td>
                <td>{s.accuracy != null ? `${Math.round(s.accuracy)}%` : "–"}</td>
                {(["inaccuracy", "mistake", "blunder"] as const).map((j) => (
                  <td key={j}>
                    <button className={`count j-${j}`} disabled={!s[j]} onClick={() => jumpTo(s.board, s.color, j)}>
                      {s[j]}
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
