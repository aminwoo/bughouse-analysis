import type { ReactNode } from "react";
import { useStore } from "../state/store";
import { automaticCpuWorkers, isLowMemoryDevice } from "../lib/device";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const cores = navigator.hardwareConcurrency || 4;
  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="settings">
        <label className="field">
          <span>Engine runs on</span>
          <select value={settings.backend} onChange={(e) => setSettings({ backend: e.target.value as typeof settings.backend })}>
            <option value="auto">Automatic (GPU when available)</option>
            <option value="webgpu">GPU (WebGPU)</option>
            <option value="wasm">CPU only</option>
          </select>
        </label>
        <label className="check" title="Faster on most GPUs; turn off if evaluations look wrong">
          <input type="checkbox" checked={settings.fp16} onChange={(e) => setSettings({ fp16: e.target.checked })} />
          Half precision (FP16) on GPUs that support it
        </label>
        <label className="field">
          <span>CPU threads</span>
          <select value={settings.threads} onChange={(e) => setSettings({ threads: Number(e.target.value) })}>
            <option value={0}>Automatic ({automaticCpuWorkers(cores, isLowMemoryDevice())})</option>
            {Array.from({ length: Math.min(16, cores) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Engine lines</span>
          <select value={settings.multiPV} onChange={(e) => setSettings({ multiPV: Number(e.target.value) })}>
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.arrows} onChange={(e) => setSettings({ arrows: e.target.checked })} />
          Show engine arrows
        </label>
      </div>
    </Modal>
  );
}

export function AboutModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="About" onClose={onClose}>
      <div className="about">
        <p>
          Bughouse Analysis reviews bughouse games with{" "}
          <a href="https://github.com/aminwoo/hivemind" target="_blank" rel="noreferrer">
            hivemind
          </a>
          , a neural-network bughouse engine. The engine runs entirely in your browser: its search is compiled to WebAssembly and the network runs on your GPU through WebGPU, or on your CPU
          when WebGPU is unavailable. The newest network is downloaded from{" "}
          <a href="https://huggingface.co/aminwoo/bughouse-twin-s-clock" target="_blank" rel="noreferrer">
            Hugging Face
          </a>{" "}
          and kept in your browser until a new one is released. Nothing is sent to a server except the request that fetches a game from chess.com.
        </p>
        <h3>Reading the review</h3>
        <p>
          The evaluation is the expected score of the <em>white team</em> (White on board A with Black on board B). Hivemind decides for a whole team at once, so its suggestions are joint moves:
          one move (or a sit) on each board.
        </p>
        <h3>Clocks</h3>
        <p>
          The engine searches on the real clocks. A team may sit while it leads its diagonal opponents (its player's clock against the same colour's clock on the other board), and every
          move it makes while on turn on both boards costs it its move time, so a lead buys only so many sits. Each team's move time is the median time its players took per move in the
          game. Moves are judged on the clocks of the position before them, so thinking time is not counted as a mistake. The engine panel's Clock menu searches the current position on
          another lead.
        </p>
        <p>
          A move is marked an inaccuracy (?!), mistake (?) or blunder (??) when its team's winning chances after it are 5, 10 or 15 percentage points below those after the engine's best move.
        </p>
        <h3>Keyboard</h3>
        <p className="kbd-list">
          <kbd>←</kbd> <kbd>→</kbd> step · <kbd>↑</kbd> <kbd>↓</kbd> start / end · <kbd>f</kbd> flip · <kbd>Space</kbd> engine on/off
        </p>
        <h3>Credits</h3>
        <p className="small">
          Engine: hivemind (MIT) with Fairy-Stockfish (GPL-3.0). Boards: chessground and chessops by lichess (GPL-3.0). Inference: onnxruntime-web (MIT). Layout inspired by Ellipsoul's{" "}
          <a href="https://bughouse.aronteh.com" target="_blank" rel="noreferrer">
            Relay
          </a>{" "}
          viewer. This site is free software under the GPL-3.0.
        </p>
      </div>
    </Modal>
  );
}
