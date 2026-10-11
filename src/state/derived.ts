// Values derived from the store, memoised per input.

import { useMemo } from "react";
import { useStore, type LiveState } from "./store";
import type { SearchInfo } from "../engine/engineClient";
import { reviewMoves, summarize, whiteValueAt, type MoveReview } from "../lib/review";
import { getNode, mainlineAnchor } from "../lib/tree";

export function useReviews(): (MoveReview | null)[] {
  const game = useStore((s) => s.game);
  const evals = useStore((s) => s.evals);
  const model = useStore((s) => s.settings.clockModel);
  return useMemo(() => reviewMoves(game, evals, model), [game, evals, model]);
}

export function useSummary() {
  const game = useStore((s) => s.game);
  const reviews = useReviews();
  const curve = useWhiteCurve();
  return useMemo(() => summarize(game, reviews, curve), [game, reviews, curve]);
}

/** Team white's value per mainline ply from the review (null where missing). */
export function useWhiteCurve(): (number | null)[] {
  const game = useStore((s) => s.game);
  const evals = useStore((s) => s.evals);
  const model = useStore((s) => s.settings.clockModel);
  const length = useStore((s) => s.tree.mainline.length);
  return useMemo(
    () => Array.from({ length }, (_, ply) => (evals[ply] ? whiteValueAt(game, evals[ply]!, model) : null)),
    [game, evals, model, length],
  );
}

export interface LiveSummary {
  /** Blended value for the searched team, once every needed search reported. */
  value: number | null;
  withTA: number | null;
  withoutTA: number | null;
  /** Lines of the more likely clock case. */
  lines: SearchInfo[];
  nodes: number;
  nps: number;
}

export function summarizeLive(live: LiveState): LiveSummary {
  const ta = live.withTA[0];
  const no = live.withoutTA[0];
  let value: number | null = null;
  if (live.weight === 1) value = ta?.value ?? null;
  else if (live.weight === 0) value = no?.value ?? null;
  else if (ta && no) value = live.weight * ta.value + (1 - live.weight) * no.value;
  const preferTA = live.weight >= 0.5;
  const lines = preferTA ? (live.withTA.length ? live.withTA : live.withoutTA) : live.withoutTA.length ? live.withoutTA : live.withTA;
  return {
    value,
    withTA: ta?.value ?? null,
    withoutTA: no?.value ?? null,
    lines,
    nodes: (ta?.nodes ?? 0) + (no?.nodes ?? 0),
    nps: Math.max(ta?.nps ?? 0, no?.nps ?? 0),
  };
}

/** Team white's value at the cursor: live engine first, then the review. */
export function useCursorValue(): number | null {
  const cursor = useStore((s) => s.cursor);
  const live = useStore((s) => s.live);
  const tree = useStore((s) => s.tree);
  const curve = useWhiteCurve();
  if (live.enabled && live.nodeId === cursor && live.searchedTeam) {
    const v = summarizeLive(live).value;
    if (v != null) return live.searchedTeam === "white" ? v : -v;
  }
  const node = getNode(tree, cursor);
  if (node.mainline) return curve[node.ply] ?? null;
  return null;
}

/** Last move on each board along the path to the cursor, as chessground keys. */
export function useLastMoves(): { A?: string[]; B?: string[] } {
  const cursor = useStore((s) => s.cursor);
  const tree = useStore((s) => s.tree);
  return useMemo(() => {
    const result: { A?: string[]; B?: string[] } = {};
    let node = tree.nodes.get(cursor);
    while (node && (!result.A || !result.B)) {
      const move = node.move;
      if (move && !result[move.board]) {
        const drop = move.uci.match(/@([a-h][1-8])$/);
        result[move.board] = drop ? [drop[1]] : [move.uci.slice(0, 2), move.uci.slice(2, 4)];
      }
      node = node.parent ? tree.nodes.get(node.parent) : undefined;
    }
    return result;
  }, [cursor, tree]);
}

/** Clocks shown at the cursor: the mainline position it hangs off. */
export function useCursorClocks() {
  const cursor = useStore((s) => s.cursor);
  const tree = useStore((s) => s.tree);
  return useMemo(() => mainlineAnchor(tree, cursor).clocks, [cursor, tree]);
}

