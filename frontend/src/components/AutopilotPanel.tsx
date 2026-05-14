import { useEffect, useState } from "react";

export interface AutopilotPanelProps {
  apiBase: string;
}

interface Decision {
  ts: number;
  command: string;
  reason: string;
  ok: boolean;
}

interface Status {
  running: boolean;
  config: { interval: number; model: string; mode: "free" | "goal"; goal: string };
  last_command: string | null;
  last_reason: string | null;
  last_error: string | null;
  decisions: Decision[];
  model_available: boolean;
}

const DEFAULT_STATUS: Status = {
  running: false,
  config: { interval: 3.0, model: "gemini-robotics-er-1.6-preview", mode: "free", goal: "" },
  last_command: null,
  last_reason: null,
  last_error: null,
  decisions: [],
  model_available: true,
};

const MODELS = [
  "gemini-robotics-er-1.6-preview",
  "gemini-robotics-er-1.5-preview",
];

export function AutopilotPanel({ apiBase }: AutopilotPanelProps) {
  const [status, setStatus] = useState<Status>(DEFAULT_STATUS);
  const [mode, setMode] = useState<"free" | "goal">("free");
  const [goal, setGoal] = useState("");
  const [interval, setIntervalSec] = useState(3.0);
  const [model, setModel] = useState(MODELS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Poll faster while running, slower while idle — autopilot decisions arrive
  // every `interval` seconds, so 1.5s gives a one-tick lag at most.
  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const r = await fetch(`${apiBase}/autopilot/status`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j: Status = await r.json();
        if (!cancelled) setStatus(j);
      } catch {
        // transient: leave previous status as-is
      }
    };
    fetchStatus();
    const periodMs = status.running ? 1500 : 4000;
    const id = setInterval(fetchStatus, periodMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [apiBase, status.running]);

  const start = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`${apiBase}/autopilot/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interval, mode, goal, model }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  const stop = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      await fetch(`${apiBase}/autopilot/stop`, { method: "POST" });
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  const lastCmd = status.last_command;
  const lastReason = status.last_reason;
  const recent = [...status.decisions].reverse().slice(0, 8);

  return (
    <div className="panel autopilot-panel">
      <div className="panel-head">
        <h2>Autopilot</h2>
        <span className={`pill ${status.running ? "ok" : "muted"}`}>
          {status.running ? "running" : "stopped"}
        </span>
      </div>

      {!status.model_available && (
        <div className="analyze-err" style={{ marginBottom: 8 }}>
          GEMINI_API_KEY not set on api service — autopilot disabled.
        </div>
      )}

      <div className="autopilot-form">
        <label className="autopilot-row">
          <span>mode</span>
          <select
            value={mode}
            disabled={status.running}
            onChange={(e) => setMode(e.target.value as "free" | "goal")}
          >
            <option value="free">free (explore)</option>
            <option value="goal">goal (target)</option>
          </select>
        </label>

        {mode === "goal" && (
          <label className="autopilot-row">
            <span>goal</span>
            <input
              type="text"
              placeholder="e.g. the red chair"
              value={goal}
              disabled={status.running}
              onChange={(e) => setGoal(e.target.value)}
            />
          </label>
        )}

        <label className="autopilot-row">
          <span>interval</span>
          <input
            type="number"
            min={1}
            max={30}
            step={0.5}
            value={interval}
            disabled={status.running}
            onChange={(e) => setIntervalSec(parseFloat(e.target.value) || 3.0)}
          />
          <small>s</small>
        </label>

        <label className="autopilot-row">
          <span>model</span>
          <select
            value={model}
            disabled={status.running}
            onChange={(e) => setModel(e.target.value)}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>

        <div className="autopilot-actions">
          {!status.running ? (
            <button className="btn" disabled={submitting || !status.model_available} onClick={start}>
              start
            </button>
          ) : (
            <button className="btn stop" disabled={submitting} onClick={stop}>
              stop
            </button>
          )}
        </div>
      </div>

      {err && <div className="analyze-err" style={{ marginTop: 8 }}>{err}</div>}
      {status.last_error && !err && (
        <div className="analyze-err" style={{ marginTop: 8 }}>{status.last_error}</div>
      )}

      {(lastCmd || lastReason) && (
        <div className="autopilot-last">
          <div className="autopilot-last-head">
            <small>last decision</small>
            {lastCmd && <span className="cmd-tag">{lastCmd}</span>}
          </div>
          {lastReason && <div className="autopilot-last-reason">{lastReason}</div>}
        </div>
      )}

      {recent.length > 0 && (
        <details className="autopilot-history">
          <summary>history ({status.decisions.length})</summary>
          <ul>
            {recent.map((d, i) => (
              <li key={i}>
                <span className="autopilot-history-ts">
                  {new Date(d.ts * 1000).toLocaleTimeString()}
                </span>
                <span className={`cmd-tag ${d.ok ? "" : "bad"}`}>{d.command}</span>
                <span className="autopilot-history-reason">{d.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
