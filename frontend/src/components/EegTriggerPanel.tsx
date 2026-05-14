import { useEffect, useState } from "react";

export interface EegTriggerPanelProps {
  apiBase: string;
  /** Live `control/state` from the WebSocket — drives the status pill so the
   *  user can see the α-power threshold firing in real time. */
  decisionState: "idle" | "active";
}

interface TriggerConfig {
  enabled: boolean;
  goal: string;
  mode: "free" | "goal";
  interval: number;
  model: string;
  last_state: "idle" | "active";
  last_transition_ts: number | null;
  model_available: boolean;
}

const DEFAULT_CONFIG: TriggerConfig = {
  enabled: false,
  goal: "人間の足元 (human leg)",
  mode: "goal",
  interval: 3.0,
  model: "gemini-robotics-er-1.6-preview",
  last_state: "idle",
  last_transition_ts: null,
  model_available: true,
};

const MODELS = [
  "gemini-robotics-er-1.6-preview",
  "gemini-robotics-er-1.5-preview",
];

export function EegTriggerPanel({ apiBase, decisionState }: EegTriggerPanelProps) {
  const [cfg, setCfg] = useState<TriggerConfig>(DEFAULT_CONFIG);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Poll the current config so two tabs stay in sync. Slow when disabled
  // (the user is probably not watching) and faster when enabled to catch
  // last_state edges.
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const r = await fetch(`${apiBase}/eeg-trigger`);
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j: TriggerConfig = await r.json();
        if (!cancelled) setCfg(j);
      } catch {
        /* transient */
      }
    };
    pull();
    const id = setInterval(pull, cfg.enabled ? 1500 : 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [apiBase, cfg.enabled]);

  const patch = async (body: Partial<TriggerConfig>) => {
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch(`${apiBase}/eeg-trigger`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      const j: TriggerConfig = await r.json();
      setCfg(j);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  const pillClass = cfg.enabled
    ? (decisionState === "active" ? "pill ok" : "pill")
    : "pill muted";
  const pillText = cfg.enabled
    ? (decisionState === "active" ? "α active → autopilot ON" : "armed · waiting for α")
    : "disabled";

  return (
    <div className="panel eeg-trigger-panel">
      <div className="eeg-trigger-row">
        <div className="eeg-trigger-head">
          <strong>α-trigger</strong>
          <span className={pillClass} role="status" aria-live="polite">{pillText}</span>
        </div>

        <div className="eeg-trigger-form">
          <label className="eeg-trigger-toggle" title="Enable: α-power dominance auto-starts the autopilot (and stops it when α drops).">
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={submitting || !cfg.model_available}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            ON
          </label>

          <label>
            <span>goal</span>
            <input
              type="text"
              value={cfg.goal}
              disabled={submitting || cfg.enabled}
              onChange={(e) => setCfg((p) => ({ ...p, goal: e.target.value }))}
              onBlur={(e) => { if (e.target.value !== cfg.goal) patch({ goal: e.target.value }); }}
              placeholder="e.g. 人間の足元"
            />
          </label>

          <label>
            <span>mode</span>
            <select
              value={cfg.mode}
              disabled={submitting || cfg.enabled}
              onChange={(e) => patch({ mode: e.target.value as "free" | "goal" })}
            >
              <option value="goal">goal</option>
              <option value="free">free</option>
            </select>
          </label>

          <label>
            <span>every</span>
            <input
              type="number"
              min={1}
              max={30}
              step={0.5}
              value={cfg.interval}
              disabled={submitting || cfg.enabled}
              onChange={(e) => patch({ interval: parseFloat(e.target.value) || 3.0 })}
            />
            <small>s</small>
          </label>

          <label>
            <span>model</span>
            <select
              value={cfg.model}
              disabled={submitting || cfg.enabled}
              onChange={(e) => patch({ model: e.target.value })}
            >
              {MODELS.map((m) => (
                <option key={m} value={m}>{m.replace("gemini-robotics-er-", "")}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="eeg-trigger-state">
          last edge:{" "}
          {cfg.last_transition_ts
            ? new Date(cfg.last_transition_ts * 1000).toLocaleTimeString()
            : "—"}
        </div>
      </div>

      {err && (
        <div className="analyze-err autopilot-strip-err" role="alert" aria-live="assertive">
          {err}
        </div>
      )}
      {!cfg.model_available && (
        <div className="analyze-err autopilot-strip-err" role="alert">
          GEMINI_API_KEY not set on api service — α-trigger autopilot disabled.
        </div>
      )}
    </div>
  );
}
