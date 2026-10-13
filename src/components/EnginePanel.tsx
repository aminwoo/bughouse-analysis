import { useStore } from "../state/store";
import { summarizeLive } from "../state/derived";
import { getNode } from "../lib/tree";
import { percent, pvToSan } from "../lib/format";
import { gameClockFor, liveClockFor, liveTeamFor } from "../engine/service";
import { networkLabel } from "../engine/network";
import type { TeamId } from "../lib/bughouse";
import type { GameRecord } from "../lib/game";
import type { SearchClock } from "../engine/engineClient";

export function teamNames(game: GameRecord, team: TeamId): string {
  const p = game.players;
  return team === "white" ? `${p.aWhite.username} & ${p.bBlack.username}` : `${p.aBlack.username} & ${p.bWhite.username}`;
}

/** Leads the clock menu offers, seconds for the searched team. */
const LEAD_CHOICES = [30, 10, 3, 0, -3, -10, -30];

function seconds(ms: number): string {
  const s = Math.abs(ms) / 1000;
  return `${s >= 10 ? s.toFixed(0) : s.toFixed(1)} s`;
}

function leadText(leadMs: number): string {
  if (leadMs === 0) return "level clocks";
  return leadMs > 0 ? `up ${seconds(leadMs)} (may sit)` : `down ${seconds(leadMs)}`;
}

function moveTimesText(clock: SearchClock): string {
  return `Move times: ${seconds(clock.teamMoveTimeMs)} for this team, ${seconds(clock.opponentMoveTimeMs)} for the opponents`;
}

export function EnginePanel() {
  const engine = useStore((s) => s.engine);
  const live = useStore((s) => s.live);
  const review = useStore((s) => s.review);
  const tree = useStore((s) => s.tree);
  const cursor = useStore((s) => s.cursor);
  const game = useStore((s) => s.game);
  const setLive = useStore((s) => s.setLive);

  const node = getNode(tree, cursor);
  const fresh = live.nodeId === cursor && live.searchedTeam != null;
  const team = fresh ? live.searchedTeam! : liveTeamFor(cursor);
  const clock = fresh && live.clock ? live.clock : liveClockFor(cursor, team);
  // The menu's auto entry shows the clocks' own lead even while another is chosen.
  const autoLeadMs = gameClockFor(cursor, team).leadMs;
  const summary = fresh ? summarizeLive(live) : null;
  const lines = summary?.lines ?? [];

  const backendLabel = engine.info
    ? engine.info.backend === "webgpu"
      ? `WebGPU${engine.info.gpu ? ` · ${engine.info.gpu}` : ""}${engine.info.fp16 ? " · FP16" : ""}`
      : `CPU · ${engine.info.slots} threads`
    : null;
  const network = engine.status === "ready" ? engine.info?.network : undefined;

  return (
    <section className="panel engine-panel">
      <header className="engine-header">
        <label className="switch" title="Analyze the current position (Space)">
          <input type="checkbox" checked={live.enabled} onChange={(e) => setLive({ enabled: e.target.checked })} />
          <span className="slider" />
        </label>
        <div className="engine-title">
          <strong>hivemind</strong>
          <span className="engine-sub" title={network ? `Network: ${networkLabel(network)}` : undefined}>
            {engine.status === "loading" && (engine.message ?? "Loading")}
            {engine.status === "loading" && engine.progress != null && ` ${Math.round(engine.progress * 100)}%`}
            {engine.status === "error" && <span className="error-text">{engine.message}</span>}
            {engine.status === "ready" && backendLabel}
            {network && network.source !== "latest" && <span className="warn-text"> · older network</span>}
            {engine.status === "off" && "Runs in your browser"}
          </span>
        </div>
        {live.enabled && summary && summary.nodes > 0 && (
          <div className="engine-eval">
            <span className="engine-eval-value" title={`${teamNames(game, team)} winning chances`}>
              <span className={`team-dot ${team}`} />
              {summary.value != null ? percent(summary.value) : "…"}
            </span>
            <span className="engine-nodes">
              {summary.nodes.toLocaleString()} nodes · {summary.nps.toLocaleString()}/s
            </span>
          </div>
        )}
      </header>
      {engine.status === "loading" && engine.progress != null && (
        <div className="progress thin">
          <div style={{ width: `${engine.progress * 100}%` }} />
        </div>
      )}
      {live.enabled && (
        <div className="engine-body">
          {review.running && <p className="muted small">Paused while the game review runs.</p>}
          <div className="engine-options">
            <label>
              <span>Team</span>
              <select value={live.team} onChange={(e) => setLive({ team: e.target.value as typeof live.team })}>
                <option value="auto">Auto: {teamNames(game, team)}</option>
                <option value="white">{teamNames(game, "white")}</option>
                <option value="black">{teamNames(game, "black")}</option>
              </select>
            </label>
            <label>
              <span>Clock</span>
              <select
                value={String(live.lead)}
                title={moveTimesText(clock)}
                onChange={(e) => setLive({ lead: e.target.value === "auto" ? "auto" : Number(e.target.value) })}
              >
                <option value="auto">Auto: {leadText(autoLeadMs)}</option>
                {LEAD_CHOICES.map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? "Level clocks" : s > 0 ? `Up ${s} s (may sit)` : `Down ${-s} s`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">{moveTimesText(clock)}</p>
          {fresh && live.notice && !review.running && <p className="muted small">{live.notice}</p>}
          {lines.length === 0 && !(fresh && live.notice) && !review.running && engine.status === "ready" && <p className="muted small">Thinking…</p>}
          <ol className="pv-lines">
            {lines.map((line) => {
              const steps = pvToSan(node.position, line.pv, team);
              return (
                <li key={line.multipv} className="pv-line">
                  <span className={`pv-eval ${line.value >= 0 ? "good" : "bad"}`} title={`${teamNames(game, team)} winning chances in this line`}>
                    {percent(line.value)}
                  </span>
                  <span className="pv-moves">
                    {steps.map((step, i) => (
                      <span key={i} className={`pv-step team-${step.team}`}>
                        {step.a && (
                          <span className="pv-move">
                            <em>A</em>
                            {step.a}
                          </span>
                        )}
                        {step.b && (
                          <span className="pv-move">
                            <em>B</em>
                            {step.b}
                          </span>
                        )}
                      </span>
                    ))}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>
  );
}
