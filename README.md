# Bughouse Analysis

**Live at https://bughouse-analysis.vercel.app**

A public bughouse analysis board in the spirit of lichess's game analysis: import a
chess.com bughouse game (or set up both boards by hand) and review it with the
[hivemind](https://github.com/aminwoo/hivemind) engine. Every move gets a judgement
(inaccuracy, mistake, blunder), each player an accuracy score, and the game an
evaluation graph.

The engine runs on the visitor's machine. Its search is compiled to WebAssembly
and the neural network runs on the GPU through WebGPU, or on the CPU when WebGPU is
unavailable. The browser always runs the newest `twin-s-clock.onnx` from
[aminwoo/bughouse-twin-s-clock](https://huggingface.co/aminwoo/bughouse-twin-s-clock),
the networks trained to play on real clocks. The only
server-side code is a small proxy that fetches games from chess.com.

## Features

- **Import from chess.com**: paste a game link or id; the partner board is found
  automatically and both boards are merged into one timeline by clock times.
- **Set up any position**: edit both boards, reserves, side to move and how far each team is up on time.
- **Two-board analysis board**: play moves and drops on either board to explore
  variations; clocks, reserves and last moves are shown per board.
- **Live engine**: hivemind's joint move for a team (one move or a sit on each
  board), with principal variations and arrows on both boards.
- **Game review**: inaccuracies `?!`, mistakes `?` and blunders `??`, accuracy per
  player, the engine's better move, and an evaluation graph. Reviews are cached
  in the browser.

## How the analysis works

Hivemind decides for a whole team at once and searches on the real clocks
(`TimeModel clock`). A team may sit, waiting instead of moving, while it leads its
diagonal opponents: A White against B White for the white team, A Black against
B Black for the black team. Every action a team plays while on turn on both boards
costs it its own move time, so a lead pays for only so many sits, and the network
reads both the lead and the two teams' move times. Each position is searched once
on the lead its clocks show. Each team's move time is the median time its players
took per move in the game, held within the 0.1–3 s the networks were trained on
(1 s when a team has made fewer than four moves). The engine panel's Clock menu
searches the current position on another lead.

Each mainline position is searched for the team that moved next in the game. When
that search prefers a different move from the one played, the same position is
searched again with the root restricted to the played move (`go … searchmoves`, see
`engine/patches/`). The other board stays free. A move is judged by how far its
value falls below the engine's best (on a −1…1 scale: 0.1 inaccuracy, 0.2
mistake, 0.3 blunder). Both values come from the same position, team and clock,
so the comparison never mixes searches made for different teams. The clock is
that of the position before the move, so thinking time alone is not counted
against it.

Accuracy follows lichess's formula. Each move scores 0–100 from its win-percentage
drop. A player's or team's accuracy is the average of two means of those scores: a
mean weighted by how volatile the evaluation was around each move, and the harmonic
mean, which keeps a few bad moves from being hidden by many easy ones.

## Architecture

```
page (React)
 ├─ engine.worker            loads public/engine/hivemind.{js,wasm}
 │   ├─ hivemind (WASM)       MCTS search + Fairy-Stockfish, pthreads (PROXY_TO_PTHREAD)
 │   │   └─ search workers ── shared-memory "slots" ──┐
 │   └─ inference.worker ×N  onnxruntime-web            │  WebGPU: 2 workers, merged batches,
 │        (WebGPU or WASM) ◄─ Atomics.wait/notify ──────┘  captured graph; CPU: 1 worker per slot
 └─ /api/chesscom            serverless proxy (no CORS on chess.com)
```

- `engine/src/engine_web.cc` implements hivemind's `Engine` interface for the
  browser: each search worker publishes a batch into a slot in wasm memory and sleeps on
  a futex; an inference worker holding the same `SharedArrayBuffer` evaluates it and
  wakes it. The C++ search is unchanged.
- `engine/src/web_main.cc` replaces the stdin UCI loop with a command queue.
- `src/engine/network.ts` picks the network. On each visit it asks the Hugging Face
  API for the sha256 of `twin-s-clock.onnx` on `main`. It downloads the file only
  when that hash changes, checks the download against it and keeps it in IndexedDB.
  GPUs with FP16 shaders run that FP16 file as published, except that
  `onnxRewrite.ts` turns its Split nodes into Slices, which onnxruntime-web's
  WebGPU backend has in FP16. Everywhere else `onnxRewrite.ts` converts the
  weights to FP32, since the CPU backend has no FP16 kernels. If Hugging Face
  is unreachable, or the new network does not fit this engine build (78×8×8
  input, clock planes included, value/policy/WDL/moves-left outputs), the engine uses the last saved network. Failing that it uses the copy
  in `public/engine`, and the engine panel shows "older network". Saved reviews
  record which network made them and are discarded when it changes.
- `src/engine/` drives the engine over UCI (`engineClient.ts`), schedules live analysis
  and reviews (`service.ts`, `reviewRunner.ts`), and serves inference (`inferenceCore.ts`).
- `src/lib/` holds bughouse rules on top of chessops (`bughouse.ts`), chess.com decoding
  (`chesscom.ts`), the merged timeline with clocks (`game.ts`), the analysis tree
  (`tree.ts`) and review maths (`review.ts`).

Because the engine uses threads, pages must be **cross-origin isolated**
(`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`).
The Vite dev server, `vercel.json` and `public/_headers` set these.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (includes the chess.com proxy)
npm test           # unit tests
npm run build      # production build in dist/
npm run preview    # serve dist/ with the right headers
```

The compiled engine and the fallback network in `public/engine/` are checked in, so
the site builds without Emscripten. To rebuild them:

```bash
source ~/emsdk/emsdk_env.sh          # Emscripten (tested with 6.0.12)
pip install onnx numpy               # for the FP16 -> FP32 conversion of the fallback network
npm run engine:build                 # clones hivemind at the pinned commit
HIVEMIND_ROOT=~/hivemind npm run engine:build   # or use a local checkout
```

The build also refreshes the fallback network (`public/engine/twin-s.onnx` and
`twin-s.json`) to the current `twin-s-clock.onnx` on Hugging Face. New network
releases reach visitors without a rebuild. Rebuild only when hivemind's input
encoding changes, and move `HIVEMIND_COMMIT` to match.

`npm run engine:test` drives the WebAssembly engine from Node with onnxruntime-node,
and `npx tsx engine/test/review.ts A.json B.json [nodes]` reviews a saved chess.com
game headlessly. `bench.html` and `engine-test.html` are development pages for
measuring network and search speed.

To measure speed:

- `npx tsx engine/test/bench.ts --fake` measures the search alone (inference
  answered instantly) for several thread counts.
- `npx tsx engine/test/gpu-bench.ts` runs `engine-test.html` in a separate headless
  Chrome on the real GPU and reports nodes per second, positions per GPU call and
  call times for each `--configs` entry (`slots x GPU workers`, or threads with
  `--backend wasm`). It needs the dev server running. `--fp16 0` forces FP32, and
  `--nvidia-f16` lets Chrome use FP16 on NVIDIA's Vulkan driver, where it is off
  by default.

On an RTX 4070 with an i5-12400F, the defaults (48 search slots × batch 8 over 3 GPU
workers) reach about 8,000–9,000 nodes per second on WebGPU. On the CPU,
11 threads reach about 475. Review searches are timed rather than limited to a
node count, so hivemind's root mate scans, which run beside the tree search for
as long as it thinks, get their share of every search: 0.5 s per search on Fast,
1 s on Normal and 3 s on Deep. Each position is searched once, plus once more
restricted to the played move when the engine preferred another (that search
skips the mate scans). FP16 makes a network call 15–28% faster for 128–256
positions and the review about 7% faster.

## Deployment

Vercel works out of the box: import the repository as a project and keep the
defaults. `vercel.json` sets the headers and `api/chesscom.ts` becomes the proxy
function. Any other static host works if it sends the two isolation headers above
and routes `/api/chesscom?id=…` to an equivalent proxy.

Production builds load onnxruntime-web's WebAssembly (14–28 MB) from jsDelivr,
pinned to the installed version, rather than shipping it. The build output is about
6 MB, and a first visit costs the host roughly 1 MB of bandwidth. The page also
fetches from `huggingface.co` (the network) and `cdn.jsdelivr.net`, and both send
the CORS headers that cross-origin isolation requires.

## Credits and license

- Engine: [hivemind](https://github.com/aminwoo/hivemind) (MIT) with
  [Fairy-Stockfish](https://github.com/fairy-stockfish/Fairy-Stockfish) (GPL-3.0).
- Boards and rules: [chessground](https://github.com/lichess-org/chessground) and
  [chessops](https://github.com/niklasf/chessops) (GPL-3.0).
- Inference: [onnxruntime-web](https://onnxruntime.ai) (MIT).
- Layout and chess.com import ideas from Ellipsoul's
  [Relay](https://github.com/Ellipsoul/bughouse-chess) viewer.

Released under the GNU General Public License v3.0 (see `LICENSE`).
