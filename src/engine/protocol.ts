// Messages between the page, the engine worker and the inference workers.

import type { NetworkInfo } from "./network";

export type InferenceBackend = "webgpu" | "wasm";

export interface EngineConfig {
  /** "auto" picks WebGPU when an adapter is available. */
  backend: "auto" | InferenceBackend;
  /** CPU inference workers when running on WASM (0 = pick from core count). */
  threads: number;
  /** Positions per network call for each search worker. */
  batchSize?: number;
  /** Search workers when running on WebGPU (their batches are merged). */
  gpuSlots?: number;
  /** WebGPU inference workers; more than one lets network calls overlap. */
  gpuWorkers?: number;
  /** Network to load (see resolveNetwork); the bundled copy when omitted. */
  network?: NetworkInfo;
}

export interface InferenceInit {
  memory: WebAssembly.Memory;
  registryPtr: number;
  slots: number[];
  backend: InferenceBackend;
  /** Network bytes; each worker gets its own copy. */
  model: Uint8Array;
}

export type InferenceMessage =
  | { type: "ready"; slots: number[]; warmupMs: number }
  | { type: "stats"; positions: number; calls: number; busyMs: number; windowMs: number }
  | { type: "error"; message: string };

export interface EngineInfo {
  backend: InferenceBackend;
  slots: number;
  batch: number;
  gpu?: string;
  /** The network actually loaded, which may be a fallback. */
  network: NetworkInfo;
}

export type ToEngine =
  | { type: "init"; config: EngineConfig; base: string }
  | { type: "cmd"; cmd: string };

export type FromEngine =
  | { type: "status"; text: string; progress?: number }
  | { type: "ready"; info: EngineInfo }
  | { type: "line"; line: string }
  | { type: "stats"; nps: number; busy: number; batchAvg: number; callMs: number }
  | { type: "error"; message: string };
