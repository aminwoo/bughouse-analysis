import { useStore } from "../state/store";
import { summarizeLive } from "../state/derived";
import { getNode } from "../lib/tree";
import { percent, pvToSan } from "../lib/format";
import { liveTeamFor, liveWeightFor } from "../engine/service";
import { networkLabel } from "../engine/network";
import type { TeamId } from "../lib/bughouse";
import type { GameRecord } from "../lib/game";

export function teamNames(game: GameRecord, team: TeamId): string {
  const p = game.players;
  return team === "white" ? `${p.aWhite.username} & ${p.bBlack.username}` : `${p.aBlack.username} & ${p.bWhite.username}`;
}

function clockText(weight: number): string {
  if (weight >= 0.995) return "up on time";
  if (weight <= 0.005) return "down on time";
  return `${Math.round(weight * 100)}% likely up on time`;
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
  const weight = fresh ? live.weight : liveWeightFor(cursor, team);
  const summary = fresh ? summarizeLive(live) : null;
  const lines = summary?.lines ?? [];

  const backendLabel = engine.info
    ? engine.info.backend === "webgpu"
      ? `WebGPU${engine.info.gpu ? ` · ${engine.info.gpu}` : ""}`
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
              <select value={live.timeAdvantage} onChange={(e) => setLive({ timeAdvantage: e.target.value as typeof live.timeAdvantage })}>
                <option value="auto">Auto: {clockText(weight)}</option>
                <option value="up">Up on time (may sit)</option>
                <option value="down">Down on time</option>
              </select>
            </label>
          </div>
          {summary && weight > 0 && weight < 1 && (summary.withTA != null || summary.withoutTA != null) && (
            <div className="ta-split small">
              <span title="If this team may sit">
                Up on time <strong>{summary.withTA != null ? percent(summary.withTA) : "…"}</strong>
              </span>
              <span title="If the opponents may sit">
                Down on time <strong>{summary.withoutTA != null ? percent(summary.withoutTA) : "…"}</strong>
              </span>
            </div>
          )}
          {lines.length === 0 && !review.running && engine.status === "ready" && <p className="muted small">Thinking…</p>}
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
