// Page-side handle on the engine worker: starts it, serialises searches and
// parses hivemind's UCI output into typed search updates.

import type { EngineConfig, EngineInfo, FromEngine, ToEngine } from "./protocol";
import type { TeamId } from "../lib/bughouse";

export interface JointMove {
  a: string | null; // null = pass (sit) on board A
  b: string | null;
}

export interface SearchInfo {
  depth: number;
  nodes: number;
  nps: number;
  timeMs: number;
  /** Searching team's expected score in [-1, 1]. */
  value: number;
  mate: number | null;
  pv: JointMove[];
  multipv: number;
}

export interface SearchResult {
  best: JointMove | null;
  info: SearchInfo | null;
  lines: SearchInfo[];
}

export interface SearchRequest {
  /** "startpos" or "fen <fenA> | <fenB>". */
  position: string;
  /** Board-prefixed UCI moves, e.g. ["1e2e4", "2d2d4"]. */
  moves: string[];
  team: TeamId;
  timeAdvantage: boolean;
  nodes?: number;
  movetime?: number;
  infinite?: boolean;
  multipv?: number;
  /** Board-prefixed moves, all on one board, that the root must choose between. */
  searchMoves?: string[];
  onInfo?: (info: SearchInfo) => void;
}

/** The go command for a request. */
export function goCommand(r: SearchRequest): string {
  const limit = r.infinite ? "infinite" : r.nodes ? `nodes ${r.nodes}` : `movetime ${r.movetime ?? 1000}`;
  return `go ${limit}${r.searchMoves?.length ? ` searchmoves ${r.searchMoves.join(" ")}` : ""}`;
}

const SCORE_C = 180;
const SCORE_K = 1.56;

/** Inverts hivemind's cp = 180 * tan(1.56 * Q). */
export function cpToValue(cp: number): number {
  return Math.max(-1, Math.min(1, Math.atan(cp / SCORE_C) / SCORE_K));
}

export function parseJointMove(token: string): JointMove | null {
  const match = token.match(/^\(([^,]+),([^)]+)\)$/);
  if (!match) return null;
  const side = (s: string) => (s === "pass" ? null : s);
  return { a: side(match[1]), b: side(match[2]) };
}

export function parseInfo(line: string): SearchInfo | null {
  if (!line.startsWith("info depth")) return null;
  const tokens = line.split(/\s+/);
  const info: SearchInfo = { depth: 0, nodes: 0, nps: 0, timeMs: 0, value: 0, mate: null, pv: [], multipv: 1 };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "depth") info.depth = Number(tokens[++i]);
    else if (t === "nodes") info.nodes = Number(tokens[++i]);
    else if (t === "nps") info.nps = Number(tokens[++i]);
    else if (t === "time") info.timeMs = Number(tokens[++i]);
    else if (t === "multipv") info.multipv = Number(tokens[++i]);
    else if (t === "score") {
      const kind = tokens[++i];
      const amount = Number(tokens[++i]);
      if (kind === "mate") {
        info.mate = amount;
        info.value = amount > 0 ? 1 : -1;
      } else {
        info.value = cpToValue(amount);
      }
    } else if (t === "pv") {
      for (let j = i + 1; j < tokens.length; j++) {
        const move = parseJointMove(tokens[j]);
        if (!move) break;
        info.pv.push(move);
      }
      break;
    }
  }
  return info;
}

type Job = {
  request: SearchRequest;
  resolve: (result: SearchResult) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
};

export class EngineClient {
  private worker: Worker;
  private lineListeners = new Set<(line: string) => void>();
  private statusListeners = new Set<(message: FromEngine) => void>();
  private queue: Job[] = [];
  private active: Job | null = null;
  private activeLines = new Map<number, SearchInfo>();
  private readyPromise: Promise<EngineInfo>;
  info: EngineInfo | null = null;

  constructor(config: EngineConfig) {
    this.worker = new Worker(new URL("./engine.worker.ts", import.meta.url), { type: "module" });
    this.readyPromise = new Promise<EngineInfo>((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<FromEngine>) => {
        const message = event.data;
        if (message.type === "ready") {
          this.info = message.info;
          resolve(message.info);
        } else if (message.type === "error") {
          reject(new Error(message.message));
          this.active?.reject(new Error(message.message));
        } else if (message.type === "line") {
          this.handleLine(message.line);
        }
        for (const listener of this.statusListeners) listener(message);
      };
      this.worker.onerror = (event) => reject(new Error(event.message || "engine worker failed"));
    });
    const base = import.meta.env.BASE_URL;
    this.post({ type: "init", config, base });
    this.send("setoption name Ponder value false");
  }

  ready(): Promise<EngineInfo> {
    return this.readyPromise;
  }

  onStatus(listener: (message: FromEngine) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  send(cmd: string) {
    this.post({ type: "cmd", cmd });
  }

  /** Queues a search. Earlier queued (not yet started) searches keep their place. */
  search(request: SearchRequest): Promise<SearchResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject, cancelled: false });
      this.pump();
    });
  }

  /** Stops the running search (it resolves with what it has) and drops queued ones. */
  cancelAll() {
    for (const job of this.queue) {
      job.cancelled = true;
      job.resolve({ best: null, info: null, lines: [] });
    }
    this.queue = [];
    if (this.active) {
      this.active.cancelled = true;
      this.send("stop");
    }
  }

  /** Stops only the running search. */
  stop() {
    if (this.active) this.send("stop");
  }

  terminate() {
    this.worker.terminate();
  }

  private post(message: ToEngine) {
    this.worker.postMessage(message);
  }

  private pump() {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    this.activeLines.clear();
    const r = job.request;
    // A fresh tree per request: retained trees were searched under other
    // Team/TimeAdvantage settings.
    this.send("ucinewgame");
    this.send(`setoption name MultiPV value ${r.multipv ?? 1}`);
    this.send(`setoption name Team value ${r.team}`);
    this.send(`setoption name TimeAdvantage value ${r.timeAdvantage ? "true" : "false"}`);
    this.send(`position ${r.position}${r.moves.length ? " moves " + r.moves.join(" ") : ""}`);
    this.send(goCommand(r));
  }

  private handleLine(line: string) {
    for (const listener of this.lineListeners) listener(line);
    const job = this.active;
    if (!job) return;
    const info = parseInfo(line);
    if (info) {
      this.activeLines.set(info.multipv, info);
      if (!job.cancelled) job.request.onInfo?.(info);
      return;
    }
    if (line.startsWith("bestmove")) {
      // The engine keeps thinking ahead after bestmove; stop it so the next
      // request starts from an idle engine.
      this.send("stop");
      const best = parseJointMove(line.split(/\s+/)[1] ?? "");
      const lines = [...this.activeLines.values()].sort((x, y) => x.multipv - y.multipv);
      this.active = null;
      job.resolve({ best, info: lines[0] ?? null, lines });
      this.pump();
    } else if (line.startsWith("info string") && line.includes("failed")) {
      console.warn("[engine]", line);
    }
  }
}
