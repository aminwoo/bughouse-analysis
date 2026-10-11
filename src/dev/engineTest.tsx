import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EngineClient, type SearchInfo } from "../engine/engineClient";
import { resolveNetwork } from "../engine/network";

function EngineTest() {
  const engine = useRef<EngineClient | null>(null);
  const [status, setStatus] = useState("idle");
  const [info, setInfo] = useState<SearchInfo | null>(null);
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const backend = (new URLSearchParams(location.search).get("backend") ?? "auto") as "auto" | "wasm" | "webgpu";
      const q = new URLSearchParams(location.search);
      // Like the app, load the latest network (?net=bundled for the bundled copy); ?fp16=0 forces FP32.
      const network = q.get("net") === "bundled" ? undefined : await resolveNetwork().catch(() => undefined);
      if (cancelled) return;
      const e = new EngineClient({
        backend,
        threads: Number(q.get("threads") ?? 0),
        batchSize: Number(q.get("batch") ?? 8),
        gpuSlots: Number(q.get("slots") ?? 0),
        gpuWorkers: Number(q.get("gpuw") ?? 0),
        network,
        fp16: q.get("fp16") !== "0",
      });
      engine.current = e;
      e.onStatus((m) => {
        if (m.type === "status") setStatus(`${m.text}${m.progress != null ? ` ${(m.progress * 100).toFixed(0)}%` : ""}`);
        if (m.type === "error") setStatus(`error: ${m.message}`);
        if (m.type === "stats") {
          const w = window as unknown as { engineStats: unknown[] };
          (w.engineStats ??= []).push(m);
        }
      });
      e.onLine((l) => setLog((prev) => [...prev.slice(-30), l]));
      e.ready().then(async (i) => {
        setStatus(`ready ${JSON.stringify(i)}`);
        (window as unknown as { engineResult: unknown }).engineResult = null;
        const t = performance.now();
        // ?moves=1e2e4,2d2d4&team=black&ta=false selects the position searched.
        const moves = q.get("moves")?.split(",").filter(Boolean) ?? [];
        const team = (q.get("team") ?? "white") as "white" | "black";
        const result = await e.search({ position: "startpos", moves, team, timeAdvantage: q.get("ta") !== "false", nodes: Number(q.get("nodes") ?? 3000), onInfo: setInfo });
        (window as unknown as { engineResult: unknown }).engineResult = { result, ms: performance.now() - t, info: i };
      }, (err) => setStatus(`error: ${err.message}`));
    })();
    return () => {
      cancelled = true;
      engine.current?.terminate();
    };
  }, []);
  return (
    <pre style={{ padding: 16 }}>
      {status}
      {"\n"}
      {info && JSON.stringify(info)}
      {"\n"}
      {log.join("\n")}
    </pre>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineTest />
  </StrictMode>,
);
