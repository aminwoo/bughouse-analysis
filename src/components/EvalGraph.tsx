import { useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useReviews, useWhiteCurve } from "../state/derived";
import { getNode } from "../lib/tree";
import type { MainlineMove } from "../lib/game";

const HEIGHT = 90;

export function EvalGraph() {
  const curve = useWhiteCurve();
  const reviews = useReviews();
  const tree = useStore((s) => s.tree);
  const cursor = useStore((s) => s.cursor);
  const goto = useStore((s) => s.goto);
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const n = tree.mainline.length;
  const width = Math.max(1, n - 1);
  const x = (ply: number) => (ply / width) * 1000;
  const y = (v: number) => HEIGHT / 2 - (v * HEIGHT) / 2;

  const paths = useMemo(() => {
    const segments: string[] = [];
    let current = "";
    curve.forEach((v, ply) => {
      if (v == null) {
        if (current) segments.push(current);
        current = "";
        return;
      }
      current += `${current ? "L" : "M"}${x(ply).toFixed(1)},${y(v).toFixed(1)}`;
    });
    if (current) segments.push(current);
    const areas = segments.map((d) => {
      const first = d.match(/^M([\d.]+)/)![1];
      const last = d.match(/([\d.]+),[\d.-]+$/)![1];
      return `${d}L${last},${HEIGHT}L${first},${HEIGHT}Z`;
    });
    return { segments, areas };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, n]);

  const cursorNode = tree.nodes.get(cursor);
  const cursorPly = cursorNode ? (cursorNode.mainline ? cursorNode.ply : null) : null;

  const plyAt = (clientX: number) => {
    const rect = svg.current!.getBoundingClientRect();
    return Math.round(((clientX - rect.left) / rect.width) * width);
  };

  if (!curve.some((v) => v != null)) {
    return (
      <div className="eval-graph empty">
        <span className="muted small">Run a game review to see how the evaluation changed.</span>
      </div>
    );
  }

  const hovered = hover != null && hover > 0 && hover < n ? (getNode(tree, tree.mainline[hover]).move as MainlineMove) : null;

  return (
    <div className="eval-graph">
      <svg
        ref={svg}
        viewBox={`0 0 1000 ${HEIGHT}`}
        preserveAspectRatio="none"
        onMouseMove={(e) => setHover(plyAt(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const ply = Math.max(0, Math.min(n - 1, plyAt(e.clientX)));
          goto(tree.mainline[ply]);
        }}
        role="img"
        aria-label="Evaluation over the game for the white team (A White and B Black)"
      >
        <rect x="0" y="0" width="1000" height={HEIGHT} className="graph-bg" />
        {paths.areas.map((d, i) => (
          <path key={`a${i}`} d={d} className="graph-area" />
        ))}
        <line x1="0" x2="1000" y1={HEIGHT / 2} y2={HEIGHT / 2} className="graph-mid" />
        {paths.segments.map((d, i) => (
          <path key={`l${i}`} d={d} className="graph-line" vectorEffect="non-scaling-stroke" />
        ))}
        {reviews.map((r) =>
          r?.judgement && curve[r.ply] != null ? (
            <line
              key={`j${r.ply}`}
              x1={x(r.ply)}
              x2={x(r.ply)}
              y1={0}
              y2={HEIGHT}
              className={`graph-mark j-${r.judgement}`}
              vectorEffect="non-scaling-stroke"
            />
          ) : null,
        )}
        {cursorPly != null && <line x1={x(cursorPly)} x2={x(cursorPly)} y1={0} y2={HEIGHT} className="graph-cursor" vectorEffect="non-scaling-stroke" />}
      </svg>
      {hovered && hover != null && (
        <div className="graph-tip" style={{ left: `${(hover / width) * 100}%` }}>
          {hovered.board}
          {hovered.number}
          {hovered.color === "white" ? "." : "…"} {hovered.san}
          {curve[hover] != null && ` · ${Math.round(50 + 50 * curve[hover]!)}%`}
        </div>
      )}
    </div>
  );
}
