// Application state: the loaded game, the analysis tree and cursor, engine and
// review status, and user settings.

import { create } from "zustand";
import type { BoardId, TeamId } from "../lib/bughouse";
import { emptyGame, type GameRecord } from "../lib/game";
import { buildTree, getNode, lineEnd, playMove, deleteVariation as removeVariation, type Tree } from "../lib/tree";
import type { PositionEval } from "../lib/review";
import type { EngineInfo } from "../engine/protocol";
import type { SearchClock, SearchInfo } from "../engine/engineClient";
import { localGet, localSet } from "../lib/storage";

export type ReviewDepth = "fast" | "normal" | "deep";

export interface Settings {
  depth: ReviewDepth;
  backend: "auto" | "webgpu" | "wasm";
  threads: number;
  /** Half precision on GPUs that support it. */
  fp16: boolean;
  arrows: boolean;
  multiPV: number;
}

const DEFAULT_SETTINGS: Settings = {
  depth: "normal",
  backend: "auto",
  threads: 0,
  fp16: true,
  arrows: true,
  multiPV: 1,
};

// Thinking time per search, ms. Reviews search by time rather than nodes so
// the engine's root mate scans, which run beside the tree search for as long
// as it thinks, get their share of every search.
export const REVIEW_MOVETIME_MS: Record<ReviewDepth, number> = { fast: 500, normal: 1000, deep: 3000 };

export interface EngineState {
  status: "off" | "loading" | "ready" | "error";
  message?: string;
  progress?: number;
  info?: EngineInfo;
  nps?: number;
}

export interface LiveState {
  enabled: boolean;
  team: "auto" | TeamId;
  /** The searched team's clock lead in seconds, or "auto" to read it from the clocks. */
  lead: "auto" | number;
  /** Node and team the current results belong to. */
  nodeId: string | null;
  searchedTeam: TeamId | null;
  /** The clock the current results were searched on. */
  clock: SearchClock | null;
  lines: SearchInfo[];
  /** Why there is nothing to show, e.g. the game is already over. */
  notice: string | null;
}

export interface ReviewState {
  running: boolean;
  done: number;
  total: number;
  /** Thinking time per search the evaluations were made with. */
  movetimeMs: number;
  /** Network the evaluations came from. */
  network?: string;
  error?: string;
}

interface AppState {
  game: GameRecord;
  tree: Tree;
  cursor: string;
  flipped: boolean;
  evals: (PositionEval | undefined)[];
  review: ReviewState;
  engine: EngineState;
  live: LiveState;
  settings: Settings;
  loading: string | null;
  error: string | null;

  loadGame: (game: GameRecord, evals?: (PositionEval | undefined)[], cursorPly?: number) => void;
  goto: (id: string) => void;
  next: () => void;
  prev: () => void;
  first: () => void;
  last: () => void;
  play: (board: BoardId, uci: string) => boolean;
  deleteVariation: (id: string) => void;
  toggleFlip: () => void;
  setEvals: (evals: (PositionEval | undefined)[]) => void;
  setEval: (e: PositionEval) => void;
  setReview: (review: Partial<ReviewState>) => void;
  setEngine: (engine: Partial<EngineState>) => void;
  setLive: (live: Partial<LiveState>) => void;
  setSettings: (settings: Partial<Settings>) => void;
  setLoading: (message: string | null) => void;
  setError: (message: string | null) => void;
}

const initialGame = emptyGame();
const initialTree = buildTree(initialGame);

export const useStore = create<AppState>((set, get) => ({
  game: initialGame,
  tree: initialTree,
  cursor: initialTree.rootId,
  flipped: false,
  evals: [],
  review: { running: false, done: 0, total: 0, movetimeMs: 0 },
  engine: { status: "off" },
  live: { enabled: false, team: "auto", lead: "auto", nodeId: null, searchedTeam: null, clock: null, lines: [], notice: null },
  settings: localGet("settings", DEFAULT_SETTINGS),
  loading: null,
  error: null,

  loadGame: (game, evals = [], cursorPly) => {
    const tree = buildTree(game);
    const ply = cursorPly == null ? 0 : Math.max(0, Math.min(cursorPly, tree.mainline.length - 1));
    set({
      game,
      tree,
      cursor: tree.mainline[ply],
      evals,
      review: { running: false, done: evals.filter(Boolean).length, total: tree.mainline.length, movetimeMs: 0 },
      live: { ...get().live, lines: [], nodeId: null, notice: null },
      error: null,
    });
  },
  goto: (id) => {
    if (get().tree.nodes.has(id)) set({ cursor: id });
  },
  next: () => {
    const { tree, cursor } = get();
    const node = getNode(tree, cursor);
    if (node.children.length) set({ cursor: node.children[0] });
  },
  prev: () => {
    const { tree, cursor } = get();
    const node = getNode(tree, cursor);
    if (node.parent) set({ cursor: node.parent });
  },
  first: () => set({ cursor: get().tree.rootId }),
  last: () => {
    const { tree, cursor } = get();
    set({ cursor: lineEnd(tree, cursor) });
  },
  play: (board, uci) => {
    const { tree, cursor } = get();
    const result = playMove(tree, cursor, board, uci);
    if (!result) return false;
    set({ tree: result.tree, cursor: result.id });
    return true;
  },
  deleteVariation: (id) => {
    const { tree, cursor } = get();
    const node = getNode(tree, id);
    const next = removeVariation(tree, id);
    // Step out of the deleted line if the cursor was inside it.
    let target = cursor;
    while (!next.nodes.has(target)) target = getNode(tree, target).parent ?? next.rootId;
    set({ tree: next, cursor: next.nodes.has(cursor) ? cursor : node.parent ?? target });
  },
  toggleFlip: () => set({ flipped: !get().flipped }),
  setEvals: (evals) => set({ evals }),
  setEval: (e) => {
    const evals = get().evals.slice();
    evals[e.ply] = e;
    set({ evals });
  },
  setReview: (review) => set({ review: { ...get().review, ...review } }),
  setEngine: (engine) => set({ engine: { ...get().engine, ...engine } }),
  setLive: (live) => set({ live: { ...get().live, ...live } }),
  setSettings: (settings) => {
    const next = { ...get().settings, ...settings };
    localSet("settings", next);
    set({ settings: next });
  },
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
