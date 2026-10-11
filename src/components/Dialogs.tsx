import type { ReactNode } from "react";
import { useStore } from "../state/store";
import type { ClockModel } from "../lib/review";

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

const CLOCK_MODELS: { value: ClockModel; label: string; help: string }[] = [
  { value: "clocks", label: "Follow the clocks", help: "Weigh the two searches by how far each team is up or down on time." },
  { value: "neutral", label: "Ignore the clocks", help: "Weigh both equally: a pure board evaluation." },
  { value: "binary", label: "Engine's view", help: "Use only the search for whichever team is ahead on time, as hivemind plays." },
];

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
        <label className="field">
          <span>CPU threads</span>
          <select value={settings.threads} onChange={(e) => setSettings({ threads: Number(e.target.value) })}>
            <option value={0}>Automatic ({Math.max(1, Math.min(8, Math.floor(cores / 2)))})</option>
            {Array.from({ length: Math.min(16, cores) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>Clocks in the evaluation</legend>
          <p className="muted small">
            hivemind's evaluation depends on which team may sit, i.e. is up on time. Each position is searched both ways and the results are combined:
          </p>
          {CLOCK_MODELS.map((m) => (
            <label key={m.value} className="radio">
              <input type="radio" name="clock-model" checked={settings.clockModel === m.value} onChange={() => setSettings({ clockModel: m.value })} />
              <span>
                <strong>{m.label}</strong>
                <span className="muted small"> {m.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
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
          <a href="https://huggingface.co/aminwoo/bughouse-twin-s" target="_blank" rel="noreferrer">
            Hugging Face
          </a>{" "}
          and kept in your browser until a new one is released. Nothing is sent to a server except the request that fetches a game from chess.com.
        </p>
        <h3>Reading the review</h3>
        <p>
          The evaluation is the expected score of the <em>white team</em> (White on board A with Black on board B). Hivemind decides for a whole team at once, so its suggestions are joint moves:
          one move (or a sit) on each board. A move is marked an inaccuracy, mistake or blunder when it lowers its team's winning chances by 5, 10 or 15 percentage points.
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
