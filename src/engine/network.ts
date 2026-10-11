// Where the network comes from. The browser downloads the newest
// twin-s-noattn.onnx from hivemind's Hugging Face repo, so the site picks up new
// releases without a redeploy. Each download is checked against the sha256 that
// Hugging Face reports, kept in IndexedDB and only repeated when the file
// changes. If Hugging Face cannot be reached, the last downloaded copy is used,
// and failing that the copy bundled with the site (public/engine).

import { convertToFp32 } from "./onnxFp32";
import { mapOutputNames } from "./inferenceCore";
import { idbGet, idbSet } from "../lib/storage";

export const NETWORK_REPO = "aminwoo/bughouse-twin-s";
export const NETWORK_FILE = "twin-s-noattn.onnx";
/** Input planes of the encoder in the bundled hivemind build. */
const INPUT_PLANES = 74;
const CACHE_KEY = "network:v1";

export interface NetworkInfo {
  /** sha256 of the published file; identifies the network. */
  id: string;
  /** Repo commit the file was taken from, when known. */
  commit?: string;
  /** When the repo was last updated, when known. */
  updated?: string;
  source: "latest" | "cached" | "bundled";
  /** Why the latest network is not the one in use. */
  problem?: string;
}

interface CachedNetwork {
  info: NetworkInfo;
  /** The published (FP16) file. */
  bytes: ArrayBuffer;
}

export function networkUrl(commit = "main"): string {
  return `https://huggingface.co/${NETWORK_REPO}/resolve/${commit}/${NETWORK_FILE}`;
}

async function fetchLatestInfo(): Promise<NetworkInfo> {
  const response = await fetch(`https://huggingface.co/api/models/${NETWORK_REPO}?blobs=true`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Hugging Face returned ${response.status}`);
  const repo = (await response.json()) as { sha: string; lastModified?: string; siblings: { rfilename: string; lfs?: { sha256: string } }[] };
  const file = repo.siblings.find((s) => s.rfilename === NETWORK_FILE);
  if (!file?.lfs) throw new Error(`${NETWORK_FILE} not found in ${NETWORK_REPO}`);
  return { id: file.lfs.sha256, commit: repo.sha, updated: repo.lastModified, source: "latest" };
}

async function bundledInfo(base: string): Promise<NetworkInfo> {
  const response = await fetch(`${base}engine/twin-s.json`);
  if (!response.ok) throw new Error(`bundled network metadata missing (${response.status})`);
  const meta = (await response.json()) as { id: string; commit?: string };
  return { id: meta.id, commit: meta.commit, source: "bundled" };
}

let resolved: Promise<NetworkInfo> | null = null;

/** The network to run: the latest release, or the best fallback when offline. */
export function resolveNetwork(base: string = import.meta.env.BASE_URL): Promise<NetworkInfo> {
  resolved ??= fetchLatestInfo().catch(async (error: unknown) => {
    console.warn("Could not check Hugging Face for the latest network", error);
    const problem = `Hugging Face unreachable: ${errorText(error)}`;
    const cached = await idbGet<CachedNetwork>(CACHE_KEY);
    return { ...(cached ? cached.info : await bundledInfo(base)), source: cached ? "cached" : "bundled", problem };
  });
  return resolved;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Converts to FP32 and checks the network fits this engine build. */
function prepare(bytes: Uint8Array): Uint8Array {
  const network = convertToFp32(bytes);
  const input = network.inputs.find((i) => i.dims.length === 4);
  const planes = input?.dims.slice(1).join("x");
  if (planes !== `${INPUT_PLANES}x8x8`) {
    throw new Error(`network input is ${planes ?? "missing"}, this engine encodes ${INPUT_PLANES}x8x8`);
  }
  mapOutputNames(network.outputs.map((o) => o.name));
  return network.model;
}

export type FetchBytes = (url: string, label: string) => Promise<Uint8Array<ArrayBuffer>>;

/**
 * Loads `target` (from `resolveNetwork`) as FP32 bytes ready for onnxruntime,
 * falling back to the cached and then the bundled copy if it cannot be used.
 * Without a target it loads the bundled copy.
 */
export async function loadNetwork(target: NetworkInfo | undefined, base: string, fetchBytes: FetchBytes): Promise<{ model: Uint8Array; info: NetworkInfo }> {
  const cached = await idbGet<CachedNetwork>(CACHE_KEY);
  let problem = target?.problem;
  if (target && target.source !== "bundled") {
    try {
      if (cached?.info.id === target.id) {
        return { model: prepare(new Uint8Array(cached.bytes)), info: target };
      }
      if (target.source === "latest") {
        const bytes = await fetchBytes(networkUrl(target.commit), "Downloading network");
        const hash = await sha256(bytes);
        if (hash !== target.id) throw new Error(`downloaded file has sha256 ${hash.slice(0, 7)}, expected ${target.id.slice(0, 7)}`);
        const model = prepare(bytes);
        await idbSet(CACHE_KEY, { info: target, bytes: bytes.buffer } satisfies CachedNetwork);
        return { model, info: target };
      }
    } catch (error) {
      console.warn("Could not use the latest network", error);
      problem = `latest network unusable: ${errorText(error)}`;
    }
    if (cached && cached.info.id !== target.id) {
      try {
        return { model: prepare(new Uint8Array(cached.bytes)), info: { ...cached.info, source: "cached", problem } };
      } catch (error) {
        console.warn("Could not use the cached network", error);
      }
    }
  }
  const info = target?.source === "bundled" ? target : { ...(await bundledInfo(base)), problem };
  return { model: await fetchBytes(`${base}engine/twin-s.onnx`, "Downloading network"), info };
}

/** Short description of the network in use, e.g. for a tooltip. */
export function networkLabel(info: NetworkInfo): string {
  const version = `${NETWORK_FILE} ${info.id.slice(0, 7)}`;
  if (info.source === "latest") return `${version} (latest from Hugging Face)`;
  const copy = info.source === "cached" ? "saved copy" : "copy bundled with the site";
  return `${version} (${copy}; ${info.problem ?? "latest unavailable"})`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
