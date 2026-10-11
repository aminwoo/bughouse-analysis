import { useState } from "react";
import { useStore } from "../state/store";

interface HeaderProps {
  onImport: (input: string) => void;
  onSetup: () => void;
  onSettings: () => void;
  onAbout: () => void;
}

export function Header({ onImport, onSetup, onSettings, onAbout }: HeaderProps) {
  const [input, setInput] = useState("");
  const loading = useStore((s) => s.loading);
  return (
    <header className="app-header">
      <a className="brand" href={import.meta.env.BASE_URL} onClick={(e) => e.preventDefault()}>
        <span className="brand-mark" aria-hidden>
          <svg viewBox="0 0 32 32" width="26" height="26">
            <rect x="2" y="6" width="13" height="20" rx="2" className="brand-a" />
            <rect x="17" y="6" width="13" height="20" rx="2" className="brand-b" />
          </svg>
        </span>
        <span className="brand-name">Bughouse Analysis</span>
      </a>
      <form
        className="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) onImport(input.trim());
        }}
      >
        <input
          className="import-input"
          placeholder="chess.com bughouse game link or id"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="chess.com game link or id"
        />
        <button className="btn primary" type="submit" disabled={!!loading || !input.trim()}>
          {loading ? "Loading…" : "Import"}
        </button>
      </form>
      <nav className="header-actions">
        <button className="btn ghost" onClick={onSetup}>
          Set up position
        </button>
        <button className="btn ghost icon" onClick={onSettings} aria-label="Settings" title="Settings">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <path
              fill="currentColor"
              d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
            />
          </svg>
        </button>
        <button className="btn ghost icon" onClick={onAbout} aria-label="About" title="About">
          ?
        </button>
      </nav>
    </header>
  );
}
