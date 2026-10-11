// Owns the single engine instance and decides what it works on: the full-game
// review when one is running, otherwise live analysis of the current node.

import { EngineClient, type SearchInfo } from "./engineClient";
import { runReview } from "./reviewRunner";
import { REVIEW_NODES, useStore } from "../state/store";
import { otherTeam, teamOf, type TeamId } from "../lib/bughouse";
import { engineRequestFor, getNode, mainlineAnchor } from "../lib/tree";
import { timeAdvantageWeight, type PositionEval } from "../lib/review";
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
  const engine = new EngineClient({ backend, threads: settings.threads, batchSize: 8, network });
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

/** Probability that `team` may sit at a node, per the live clock setting. */
export function liveWeightFor(nodeId: string, team: TeamId): number {
  const { tree, live, settings } = useStore.getState();
  if (live.timeAdvantage !== "auto") return live.timeAdvantage === "up" ? 1 : 0;
  return timeAdvantageWeight(mainlineAnchor(tree, nodeId).clocks, team, settings.clockModel);
}

let liveToken = 0;
let liveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleLive() {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => void startLive(), 120);
}

/**
 * Searches the cursor position for one team. With a definite clock situation
 * that is a single endless search; otherwise searches with and without the
 * time advantage alternate with growing budgets so both values firm up.
 */
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
  const weight = liveWeightFor(cursor, team);
  setLive({ nodeId: cursor, searchedTeam: team, weight, withTA: [], withoutTA: [] });
  const request = { ...engineRequestFor(tree, game, cursor), team, multipv: settings.multiPV };
  const collect = (key: "withTA" | "withoutTA") => {
    const lines: SearchInfo[] = [];
    return (info: SearchInfo) => {
      if (token !== liveToken) return;
      lines[info.multipv - 1] = info;
      useStore.getState().setLive({ [key]: lines.filter(Boolean).slice() });
    };
  };

  if (weight === 0 || weight === 1) {
    const key = weight === 1 ? "withTA" : "withoutTA";
    void engine.search({ ...request, timeAdvantage: weight === 1, infinite: true, onInfo: collect(key) });
    return;
  }
  let budget = engine.info!.backend === "webgpu" ? 600 : 150;
  for (let round = 0; round < 7 && token === liveToken; round++, budget *= 2) {
    // Search the more likely case first so its line shows up sooner.
    const order: boolean[] = weight >= 0.5 ? [true, false] : [false, true];
    for (const ta of order) {
      if (token !== liveToken) return;
      await engine.search({ ...request, timeAdvantage: ta, nodes: budget, onInfo: collect(ta ? "withTA" : "withoutTA") });
    }
  }
}

export function stopLive() {
  liveToken++;
  client?.cancelAll();
}

let reviewToken = 0;

interface CachedReview {
  nodes: number;
  /** Network that produced the evaluations. */
  network: string;
  evals: (PositionEval | undefined)[];
}

function cacheKey(gameKey: string) {
  return `review:v2:${gameKey}`;
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
  const nodes = REVIEW_NODES[engine.info!.backend][settings.depth];
  const network = engine.info!.network.id;
  // Resume only work done at the same depth with the same network.
  const existing = review.nodes === nodes && review.network === network ? evals : [];
  if (existing !== evals) useStore.getState().setEvals([]);
  setReview({ running: true, nodes, network, total: tree.mainline.length, done: existing.filter(Boolean).length, error: undefined });
  const gameKey = game.key;
  let lastSave = 0;
  const save = () => idbSet(cacheKey(gameKey), { nodes, network, evals: useStore.getState().evals } satisfies CachedReview);
  try {
    await runReview(engine, game, tree, {
      nodes,
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
    state.live.timeAdvantage !== prev.live.timeAdvantage ||
    state.settings.multiPV !== prev.settings.multiPV ||
    state.settings.clockModel !== prev.settings.clockModel ||
    state.game !== prev.game;
  if (state.game !== prev.game && prev.review.running) stopReview();
  if (liveChanged) {
    if (state.live.enabled) scheduleLive();
    else if (prev.live.enabled) stopLive();
  }
  if (state.settings.backend !== prev.settings.backend || state.settings.threads !== prev.settings.threads) {
    if (client) restartEngine();
  }
});
