import { useCallback, useEffect, useRef, useState } from "react";

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
  last_state: "idle" | "active" | null;
  last_transition_ts: number | null;
  model_available: boolean;
}

const DEFAULT_CONFIG: TriggerConfig = {
  enabled: false,
  goal: "人間の足元 (human leg)",
  mode: "goal",
  interval: 3.0,
  model: "gemini-robotics-er-1.6-preview",
  last_state: null,
  last_transition_ts: null,
  model_available: true,
};

const MODELS = [
  "gemini-robotics-er-1.6-preview",
  "gemini-robotics-er-1.5-preview",
];

export function EegTriggerPanel({ apiBase, decisionState }: EegTriggerPanelProps) {
  const [cfg, setCfg] = useState<TriggerConfig>(DEFAULT_CONFIG);
  // Locally-typed goal that's not yet persisted (committed on blur or before
  // toggling enable). Tracked separately so React doesn't yank the cursor on
  // every poll-driven setCfg.
  const [goalDraft, setGoalDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Autopilot run status (polled alongside the trigger). Used so the test
  // button can flip to "stop" while a run is live without us having to wire
  // a second WebSocket topic.
  const [autopilotRunning, setAutopilotRunning] = useState(false);

  // Stash the latest `enabled` so the polling effect can read it without
  // depending on `cfg.enabled` directly (which would re-create the interval
  // on every poll and on every keystroke into goal).
  const enabledRef = useRef(cfg.enabled);
  enabledRef.current = cfg.enabled;

  // Poll the current config so two tabs stay in sync. Slow when disabled
  // (user probably isn't watching) and faster when enabled to catch
  // last_state edges. The effect is mounted ONCE — interval recadences
  // itself by reading `enabledRef` on each tick.
  useEffect(() => {
    let cancelled = false;
    let id: ReturnType<typeof setTimeout>;
    const pull = async () => {
      try {
        const [tr, ar] = await Promise.all([
          fetch(`${apiBase}/eeg-trigger`).then((r) => r.ok ? r.json() : Promise.reject(r.status)),
          fetch(`${apiBase}/autopilot/status`).then((r) => r.ok ? r.json() : null),
        ]);
        if (!cancelled) {
          setCfg(tr as TriggerConfig);
          if (ar && typeof ar.running === "boolean") setAutopilotRunning(ar.running);
        }
      } catch {
        /* transient */
      } finally {
        if (!cancelled) {
          id = setTimeout(pull, enabledRef.current ? 1500 : 5000);
        }
      }
    };
    pull();
    return () => { cancelled = true; clearTimeout(id); };
  }, [apiBase]);

  const patch = useCallback(async (body: Partial<TriggerConfig>) => {
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
      // Server is now authoritative for the goal; clear any unsaved draft.
      if ("goal" in body) setGoalDraft(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }, [apiBase]);

  const toggleEnabled = async (next: boolean) => {
    // If the user typed a new goal but never blurred, persist it before we
    // arm the trigger. Otherwise the in-flight text would be silently lost.
    if (next && goalDraft !== null && goalDraft !== cfg.goal) {
      await patch({ goal: goalDraft, enabled: true });
    } else {
      await patch({ enabled: next });
    }
  };

  // Test fire: manually launch the autopilot as if α had crossed the
  // threshold, using the current trigger config. Same `src="eeg"` stamp as
  // a real α fire, so the OFF toggle (and the autopilot's own stop button)
  // can tear it down. If autopilot is already running, the button becomes a
  // stop shortcut.
  const testFireOrStop = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      // If the user typed a fresh goal but never blurred, persist it first
      // so the test run uses the on-screen text, not the stale server value.
      if (!autopilotRunning && goalDraft !== null && goalDraft !== cfg.goal) {
        await fetch(`${apiBase}/eeg-trigger`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: goalDraft }),
        });
        setGoalDraft(null);
      }
      const url = autopilotRunning ? `${apiBase}/autopilot/stop` : `${apiBase}/eeg-trigger/test-fire`;
      const r = await fetch(url, { method: "POST" });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      // Optimistic flip — the poll will overwrite within ~1.5s.
      setAutopilotRunning(!autopilotRunning);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  // Three visual states for safety: OFF (idle) / ARMED (waiting for α) /
  // FIRING (α-active, autopilot launched). "armed" must read distinctly
  // from "off" — the robot may move at any moment.
  let pillClass = "pill muted";
  let pillText = "off";
  if (cfg.enabled) {
    if (decisionState === "active") {
      pillClass = "pill ok";
      pillText = "α active · autopilot ON";
    } else {
      pillClass = "pill warn";
      pillText = "armed · waiting for α";
    }
  }

  const goalValue = goalDraft ?? cfg.goal;

  return (
    <div className="panel eeg-trigger-panel">
      <div className="eeg-trigger-row">
        <div className="eeg-trigger-head">
          <strong>α-trigger</strong>
          <span className={pillClass} role="status" aria-live="polite">{pillText}</span>
        </div>

        <div className="eeg-trigger-form">
          <label
            className={`eeg-trigger-toggle ${cfg.enabled ? "on" : ""}`}
            title="Enable: α-power dominance auto-starts the autopilot toward the goal; auto-stops when α drops."
          >
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={submitting || !cfg.model_available}
              onChange={(e) => toggleEnabled(e.target.checked)}
              aria-label="α-trigger enable"
            />
            {cfg.enabled ? "ON" : "OFF"}
          </label>

          <label>
            <span>goal</span>
            <input
              type="text"
              value={goalValue}
              disabled={submitting || cfg.enabled}
              onChange={(e) => setGoalDraft(e.target.value)}
              onBlur={() => {
                if (goalDraft !== null && goalDraft !== cfg.goal) {
                  patch({ goal: goalDraft });
                }
              }}
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

          <button
            type="button"
            className={`btn small ${autopilotRunning ? "stop" : ""}`}
            disabled={submitting || !cfg.model_available}
            onClick={testFireOrStop}
            title={
              autopilotRunning
                ? "Stop the currently running autopilot."
                : "Fire the autopilot now with the current goal — useful for testing without actually triggering α."
            }
          >
            {autopilotRunning ? "stop" : "test fire"}
          </button>
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
