// Phones and tablets get a much smaller engine than a desktop. Their browsers
// close a tab that outgrows a memory limit well below a desktop's. In Chrome
// each CPU inference worker costs some 85 MB (its own onnxruntime), each
// search slot's thread about 5 MB, and the tree about 3 KB a node.

interface NavigatorHints {
  userAgentData?: { mobile?: boolean };
  /** GB of RAM, rounded and capped at 8; Chromium only. */
  deviceMemory?: number;
}

/** Whether to run the engine's low-memory profile. */
export function isLowMemoryDevice(): boolean {
  const hints = navigator as Navigator & NavigatorHints;
  if (hints.userAgentData?.mobile) return true;
  if (hints.deviceMemory != null && hints.deviceMemory <= 4) return true;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS reports itself as a Mac; only the touch screen gives it away.
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** CPU inference workers the engine picks when the setting is automatic. */
export function automaticCpuWorkers(cores: number, lowMemory: boolean): number {
  return lowMemory ? Math.max(1, Math.min(2, cores - 1)) : Math.max(1, Math.min(16, cores - 1));
}

/**
 * Nodes a live analysis searches before it stops. hivemind's own ceiling for
 * `go infinite` (2M nodes) is more than a 4 GB WebAssembly heap holds at 3 KB
 * a node, so desktops stop at 800k (about 2.3 GB) and phones at 100k
 * (about 300 MB, on top of the 330-400 MB the engine takes to start there).
 */
export function liveAnalysisNodes(lowMemory: boolean): number {
  return lowMemory ? 100_000 : 800_000;
}
