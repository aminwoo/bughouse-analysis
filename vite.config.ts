import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

// SharedArrayBuffer (and so the threaded engine) needs cross-origin isolation.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Piece sprites outside a board (reserves, palettes) reuse chessground's
// embedded SVGs under a `.piece` class instead of its custom <piece> element.
function pieceSprites(): Plugin {
  const generate = () => {
    const css = fs.readFileSync(path.resolve("node_modules/chessground/assets/chessground.cburnett.css"), "utf8");
    const out = css.replace(/\.cg-wrap piece\./g, ".piece.");
    fs.mkdirSync(path.resolve("src/generated"), { recursive: true });
    const target = path.resolve("src/generated/pieces.css");
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== out) fs.writeFileSync(target, out);
  };
  return { name: "piece-sprites", config: generate };
}

// Local stand-in for the serverless chess.com proxy (api/chesscom.ts).
function chessComDevProxy(): Plugin {
  const handler = (load: () => Promise<typeof import("./api/chesscom")>) =>
    async (req: { url?: string }, res: import("node:http").ServerResponse) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const { fetchChessComGame } = await load();
      const result = await fetchChessComGame(url.searchParams.get("id") ?? "");
      res.statusCode = result.status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.end(JSON.stringify(result.body));
    };
  return {
    name: "chesscom-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/chesscom", handler(() => server.ssrLoadModule("/api/chesscom.ts") as never));
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/chesscom", handler(() => import("./api/chesscom")));
    },
  };
}

// onnxruntime-web's WebAssembly is served by jsDelivr in production (see
// inference.worker.ts), pinned to the installed version, so the copies Vite
// would emit are dropped. That keeps each visit from costing ~7 MB of the
// host's bandwidth and every file under static hosts' size limits.
const ortVersion: string = JSON.parse(fs.readFileSync(path.resolve("node_modules/onnxruntime-web/package.json"), "utf8")).version;

function dropOrtWasm(): Plugin {
  return {
    name: "drop-ort-wasm",
    apply: "build",
    generateBundle(_, bundle) {
      for (const name of Object.keys(bundle)) if (/ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
    },
  };
}

export default defineConfig({
  plugins: [react(), pieceSprites(), chessComDevProxy(), dropOrtWasm()],
  define: { __ORT_VERSION__: JSON.stringify(ortVersion) },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: "es", plugins: () => [dropOrtWasm()] },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
});
