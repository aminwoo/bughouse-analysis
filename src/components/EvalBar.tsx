import type React from "react";

interface EvalBarProps {
  /** Team white's value in [-1, 1], or null when unknown. */
  value: number | null;
  /** True when team white sits at the top of the boards. */
  flipped: boolean;
  label?: string;
}

export function EvalBar({ value, flipped, label }: EvalBarProps) {
  const white = value == null ? 50 : 50 + 50 * Math.max(-1, Math.min(1, value));
  const text = value == null ? "" : `${Math.round(white)}`;
  return (
    <div className={`eval-bar ${flipped ? "flipped" : ""} ${value == null ? "unknown" : ""}`} title={label}>
      <div className="eval-bar-white" style={{ "--white": `${white}%` } as React.CSSProperties} />
      <span className={`eval-bar-text ${white >= 50 ? "white-side" : "black-side"}`}>{text}</span>
    </div>
  );
}
