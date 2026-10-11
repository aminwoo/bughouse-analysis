import { useEffect, useRef, type ReactNode } from "react";
import { useStore } from "../state/store";
import { useReviews } from "../state/derived";
import { getNode, type Tree, type TreeNode } from "../lib/tree";
import { JUDGEMENTS, type MoveReview } from "../lib/review";
import type { MainlineMove } from "../lib/game";

const GLYPH: Record<string, string> = Object.fromEntries(JUDGEMENTS.map((j) => [j.name, j.glyph]));

function moveLabel(node: TreeNode): string {
  const move = node.move!;
  const full = node.position.board(move.board).fullmoves;
  const number = move.color === "white" ? full : full - 1;
  return `${move.board}${number}${move.color === "white" ? "." : "…"}`;
}

function thinkTime(move: MainlineMove): string {
  const s = move.thinkTime / 10;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

export function MoveList() {
  const tree = useStore((s) => s.tree);
  const cursor = useStore((s) => s.cursor);
  const game = useStore((s) => s.game);
  const goto = useStore((s) => s.goto);
  const deleteVariation = useStore((s) => s.deleteVariation);
  const reviews = useReviews();
  const container = useRef<HTMLDivElement>(null);

  // Keep the current move visible by scrolling the list only, never the page.
  useEffect(() => {
    const list = container.current;
    const el = list?.querySelector<HTMLElement>(".active");
    if (!list || !el) return;
    const top = el.offsetTop; // .move-list is the offset parent
    if (top < list.scrollTop) list.scrollTop = top - 8;
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight + 8;
  }, [cursor]);

  const p = game.players;
  const columns = [
    { board: "A", color: "white", player: p.aWhite },
    { board: "A", color: "black", player: p.aBlack },
    { board: "B", color: "white", player: p.bWhite },
    { board: "B", color: "black", player: p.bBlack },
  ] as const;

  const rows: ReactNode[] = [];
  const pushVariations = (parent: TreeNode, key: string) => {
    const alternatives = parent.children.filter((id) => !tree.nodes.get(id)?.mainline);
    if (!alternatives.length) return;
    rows.push(
      <div className="variation-block" key={`var-${key}`}>
        {alternatives.map((id) => (
          <Variation key={id} tree={tree} startId={id} cursor={cursor} goto={goto} onDelete={deleteVariation} />
        ))}
      </div>,
    );
  };

  for (let ply = 1; ply < tree.mainline.length; ply++) {
    const node = getNode(tree, tree.mainline[ply]);
    const move = node.move as MainlineMove;
    const review = reviews[ply];
    const column = columns.findIndex((c) => c.board === move.board && c.color === move.color);
    rows.push(
      <div className={`move-row ${move.board === "A" ? "row-a" : "row-b"}`} key={node.id}>
        {columns.map((_, i) =>
          i === column ? (
            <button key={i} className={`move-cell ${node.id === cursor ? "active" : ""} ${review?.judgement ? `j-${review.judgement}` : ""}`} onClick={() => goto(node.id)}>
              <span className="move-number">{moveLabel(node)}</span>
              <span className="move-san">
                {move.san}
                {review?.judgement && <span className="glyph">{GLYPH[review.judgement]}</span>}
              </span>
              <span className="move-time">{thinkTime(move)}</span>
            </button>
          ) : (
            <span key={i} className="move-cell empty" />
          ),
        )}
      </div>,
    );
    pushVariations(getNode(tree, node.parent!), node.parent!);
  }
  const lastMain = getNode(tree, tree.mainline[tree.mainline.length - 1]);
  pushVariations(lastMain, `end-${lastMain.id}`);

  return (
    <section className="panel move-panel">
      <div className="move-header">
        {columns.map((c) => (
          <span key={`${c.board}${c.color}`} className={`move-head ${c.color}`} title={`${c.player.username} (${c.color === "white" ? "White" : "Black"} on ${c.board})`}>
            <span className="move-head-board">{c.board}</span>
            <span className="move-head-name">{c.player.username}</span>
          </span>
        ))}
      </div>
      <div className="move-list" ref={container}>
        <button className={`move-start ${cursor === tree.rootId ? "active" : ""}`} onClick={() => goto(tree.rootId)}>
          Start position
        </button>
        {rows}
        {tree.mainline.length === 1 && rows.length === 0 && <p className="muted small empty-hint">Make moves on either board, or import a game.</p>}
        {game.result?.message && tree.mainline.length > 1 && <div className="game-result">{game.result.message}</div>}
        {game.droppedMoves > 0 && <div className="game-result warn">{game.droppedMoves} moves could not be replayed and were left out.</div>}
      </div>
      <ReviewLegend reviews={reviews} />
    </section>
  );
}

function ReviewLegend({ reviews }: { reviews: (MoveReview | null)[] }) {
  if (!reviews.some(Boolean)) return null;
  return (
    <div className="legend">
      {JUDGEMENTS.slice()
        .reverse()
        .map((j) => (
          <span key={j.name} className={`legend-item j-${j.name}`}>
            <span className="glyph">{j.glyph}</span> {j.name}
          </span>
        ))}
    </div>
  );
}

interface VariationProps {
  tree: Tree;
  startId: string;
  cursor: string;
  goto: (id: string) => void;
  onDelete: (id: string) => void;
}

function Variation({ tree, startId, cursor, goto, onDelete }: VariationProps) {
  const tokens: ReactNode[] = [];
  let node: TreeNode | undefined = tree.nodes.get(startId);
  while (node) {
    const current: TreeNode = node;
    tokens.push(
      <button key={current.id} className={`var-move ${current.id === cursor ? "active" : ""}`} onClick={() => goto(current.id)}>
        <span className="move-number">{moveLabel(current)}</span>
        {current.move!.san}
      </button>,
    );
    const [next, ...alternatives] = current.children;
    for (const alt of alternatives) {
      tokens.push(
        <span key={`alt-${alt}`} className="nested">
          (<Variation tree={tree} startId={alt} cursor={cursor} goto={goto} onDelete={onDelete} />)
        </span>,
      );
    }
    node = next ? tree.nodes.get(next) : undefined;
  }
  return (
    <span className="variation">
      {tokens}
      <button className="var-delete" title="Delete this variation" onClick={() => onDelete(startId)}>
        ×
      </button>
    </span>
  );
}
