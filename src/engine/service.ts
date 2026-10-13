// Owns the single engine instance and decides what it works on: the full-game
// review when one is running, otherwise live analysis of the current node.

import { EngineClient, type SearchInfo } from "./engineClient";
import { runReview } from "./reviewRunner";
import { REVIEW_MOVETIME_MS, useStore } from "../state/store";
import { BOARDS, otherTeam, teamOf, type TeamId } from "../lib/bughouse";
import { engineRequestFor, getNode, mainlineAnchor } from "../lib/tree";
import { searchClock, teamMoveTimes, type PositionEval } from "../lib/review";
import type { SearchClock } from "./engineClient";
import { idbGet, idbSet } from "../lib/storage";
import { resolveNetwork, type NetworkInfo } from "./network";

let client: EngineClient | null = null;
let clientReady: Promise<EngineClient> | null = null;
/** Bumped by restartEngine so a start still checking the network is dropped. */
let generation = 0;

export function ensureEngine(): Promise<EngineClient> {
  if (clientReady) return clientReady;
  const { settings, setEngine } = useStore.getState();
  const started = generation;
  setEngine({ status: "loading", message: "Checking for the latest network", progress: undefined });
  clientReady = resolveNetwork()
    .catch(() => undefined)
    .then((network) => {
      if (started !== generation) throw new Error("engine restarted");
      return startEngine(settings.backend, network).catch((error: Error) => {
        // A GPU that fails to initialise should not leave the user without an engine.
        if (settings.backend === "wasm") throw error;
        console.warn("GPU engine failed, falling back to the CPU", error);
        return startEngine("wasm", network, `GPU unavailable (${error.message}); using the CPU`);
      });
    });
  clientReady.catch(() => {
    clientReady = null;
  });
  return clientReady;
}

function startEngine(backend: "auto" | "webgpu" | "wasm", network: NetworkInfo | undefined, notice?: string): Promise<EngineClient> {
  const { settings, setEngine } = useStore.getState();
  const engine = new EngineClient({ backend, threads: settings.threads, batchSize: 8, network, fp16: settings.fp16 });
  client = engine;
  setEngine({ status: "loading", message: notice ?? "Starting engine", progress: undefined });
  engine.onStatus((m) => {
    if (client !== engine) return;
    if (m.type === "status") setEngine({ message: m.text, progress: m.progress });
    else if (m.type === "stats") setEngine({ nps: m.nps });
    else if (m.type === "error" && useStore.getState().engine.status === "ready") setEngine({ status: "error", message: m.message });
  });
  return engine.ready().then(
    (info) => {
      setEngine({ status: "ready", info, message: undefined, progress: undefined });
      return engine;
    },
    (error: Error) => {
      engine.terminate();
      if (client === engine) client = null;
      if (backend === "wasm" || settings.backend === "wasm") setEngine({ status: "error", message: error.message });
      throw error;
    },
  );
}

/** Drops the engine so the next use starts one with the current settings. */
export function restartEngine() {
  generation++;
  client?.terminate();
  client = null;
  clientReady = null;
  useStore.getState().setEngine({ status: "off", info: undefined, nps: undefined });
  const { live, review } = useStore.getState();
  if (review.running) useStore.getState().setReview({ running: false });
  if (live.enabled) scheduleLive();
}

/** Team the live engine searches for at the cursor. */
export function liveTeamFor(nodeId: string): TeamId {
  const { tree, live } = useStore.getState();
  if (live.team !== "auto") return live.team;
  const node = getNode(tree, nodeId);
  if (node.mainline && node.children.length) {
    const next = getNode(tree, node.children[0]);
    if (next.mainline && next.move) return teamOf(next.move.board, next.move.color);
  }
  if (node.move) return otherTeam(teamOf(node.move.board, node.move.color));
  return "white";
}

/** `team`'s clock at a node as the game's clocks have it. */
export function gameClockFor(nodeId: string, team: TeamId): SearchClock {
  const { tree, game } = useStore.getState();
  return searchClock(mainlineAnchor(tree, nodeId).clocks, team, teamMoveTimes(game));
}

/** The clock the live engine searches `team` on at a node, per the live clock setting. */
export function liveClockFor(nodeId: string, team: TeamId): SearchClock {
  const { lead } = useStore.getState().live;
  const clock = gameClockFor(nodeId, team);
  return lead === "auto" ? clock : { ...clock, leadMs: lead * 1000 };
}

let liveToken = 0;
let liveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleLive() {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => void startLive(), 120);
}

/** Searches the cursor position for one team on its clock, until stopped. */
async function startLive() {
  const token = ++liveToken;
  const state = useStore.getState();
  if (!state.live.enabled || state.review.running) {
    client?.cancelAll();
    return;
  }
  let engine: EngineClient;
  try {
    engine = await ensureEngine();
  } catch {
    return;
  }
  if (token !== liveToken) return;
  engine.cancelAll();
  const { tree, game, cursor, settings, setLive } = useStore.getState();
  const team = liveTeamFor(cursor);
  const clock = liveClockFor(cursor, team);
  // A mated board ends the game: there is nothing left to search.
  const mated = BOARDS.find((board) => getNode(tree, cursor).position.isMate(board));
  if (mated) {
    setLive({ nodeId: cursor, searchedTeam: team, clock, lines: [], notice: `Checkmate on board ${mated}: the game is over.` });
    return;
  }
  setLive({ nodeId: cursor, searchedTeam: team, clock, lines: [], notice: null });
  const lines: SearchInfo[] = [];
  const onInfo = (info: SearchInfo) => {
    if (token !== liveToken) return;
    lines[info.multipv - 1] = info;
    useStore.getState().setLive({ lines: lines.filter(Boolean).slice() });
  };
  void engine
    .search({ ...engineRequestFor(tree, game, cursor), team, clock, multipv: settings.multiPV, infinite: true, onInfo })
    .then((result) => {
      // An analysis only ends by itself when there was nothing to search.
      if (token === liveToken && !result.info && lines.length === 0) {
        useStore.getState().setLive({ notice: "The engine found nothing to search in this position." });
      }
    });
}

export function stopLive() {
  liveToken++;
  client?.cancelAll();
}

let reviewToken = 0;

interface CachedReview {
  movetimeMs: number;
  /** Network that produced the evaluations. */
  network: string;
  evals: (PositionEval | undefined)[];
}

function cacheKey(gameKey: string) {
  // v3 held the two time-advantage searches per position, v4 node budgets.
  return `review:v5:${gameKey}`;
}

/** The saved review of a game, if it was made with the current network. */
export async function loadCachedReview(gameKey: string): Promise<CachedReview | undefined> {
  const [cached, network] = await Promise.all([idbGet<CachedReview>(cacheKey(gameKey)), resolveNetwork().catch(() => null)]);
  return cached && cached.network === network?.id ? cached : undefined;
}

export async function startReview() {
  const token = ++reviewToken;
  let engine: EngineClient;
  try {
    engine = await ensureEngine();
  } catch {
    return;
  }
  if (token !== reviewToken) return;
  liveToken++;
  engine.cancelAll();
  const { game, tree, settings, review, evals, setReview, setEval } = useStore.getState();
  const movetimeMs = REVIEW_MOVETIME_MS[settings.depth];
  const network = engine.info!.network.id;
  // Resume only work done at the same depth with the same network.
  const existing = review.movetimeMs === movetimeMs && review.network === network ? evals : [];
  if (existing !== evals) useStore.getState().setEvals([]);
  setReview({ running: true, movetimeMs, network, total: tree.mainline.length, done: existing.filter(Boolean).length, error: undefined });
  const gameKey = game.key;
  let lastSave = 0;
  const save = () => idbSet(cacheKey(gameKey), { movetimeMs, network, evals: useStore.getState().evals } satisfies CachedReview);
  try {
    await runReview(engine, game, tree, {
      movetimeMs,
      existing,
      isCancelled: () => token !== reviewToken || useStore.getState().game.key !== gameKey,
      onEval: (e) => {
        if (token !== reviewToken) return;
        setEval(e);
        setReview({ done: useStore.getState().evals.filter(Boolean).length });
        if (performance.now() - lastSave > 5000) {
          lastSave = performance.now();
          void save();
        }
      },
    });
    if (token === reviewToken) await save();
  } catch (error) {
    setReview({ error: error instanceof Error ? error.message : String(error) });
  }
  if (token === reviewToken) {
    setReview({ running: false });
    scheduleLive();
  }
}

export function stopReview() {
  reviewToken++;
  client?.cancelAll();
  useStore.getState().setReview({ running: false });
  scheduleLive();
}

// Restart live analysis whenever what it depends on changes.
useStore.subscribe((state, prev) => {
  const liveChanged =
    state.cursor !== prev.cursor ||
    state.live.enabled !== prev.live.enabled ||
    state.live.team !== prev.live.team ||
    state.live.lead !== prev.live.lead ||
    state.settings.multiPV !== prev.settings.multiPV ||
    state.game !== prev.game;
  if (state.game !== prev.game && prev.review.running) stopReview();
  if (liveChanged) {
    if (state.live.enabled) scheduleLive();
    else if (prev.live.enabled) stopLive();
  }
  if (state.settings.backend !== prev.settings.backend || state.settings.threads !== prev.settings.threads || state.settings.fp16 !== prev.settings.fp16) {
    if (client) restartEngine();
  }
});
