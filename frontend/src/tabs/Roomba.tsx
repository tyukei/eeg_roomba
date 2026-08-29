import { useEffect, useState } from "react";
import { AutopilotPanel } from "../components/AutopilotPanel";
import { CameraView } from "../components/CameraView";
import { EegTriggerPanel } from "../components/EegTriggerPanel";
import { EmergencyStop } from "../components/EmergencyStop";
import { Joystick } from "../components/Joystick";
import { TrajectoryMap } from "../components/TrajectoryMap";
import { AppState, TrajectoryStep } from "../types";

export interface RoombaTabProps {
  state: AppState;
  history: TrajectoryStep[];
  apiBase: string;
  camOn: boolean;
  setCamOn: (v: boolean) => void;
}

export function Roomba({ state, history, apiBase, camOn, setCamOn }: RoombaTabProps) {
  const [bridge, setBridge] = useState<{ connected: boolean; sensor: Record<string, number | boolean>; sensor_ts?: number | null; error?: string }>({ connected: false, sensor: {} });
  const cmd = (c: string) => {
    fetch(`${apiBase}/control/${c}`, { method: "POST" }).catch(() => {});
  };

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch(`${apiBase}/control/state`);
        if (!r.ok) return;
        const next = await r.json();
        if (!cancelled) setBridge({ connected: !!next.connected, sensor: next.sensor ?? {}, sensor_ts: next.sensor_ts, error: next.error });
      } catch {
        if (!cancelled) setBridge((old) => ({ ...old, connected: false }));
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [apiBase]);

  const lastCmds = history.slice(-12).reverse();

  return (
    <div className="roomba-wrap compact">
      <EmergencyStop apiBase={apiBase} />

      <CameraView apiBase={apiBase} camOn={camOn} setCamOn={setCamOn} />

      <TrajectoryMap history={history} />

      <div className="panel ctrl-panel">
        <div className="panel-head">
          <h2>Control</h2>
          <div className="ctrl-conn">
            <span className={`bridge-dot ${bridge.connected ? "ok" : "bad"}`} title={bridge.connected ? "Arduino connected" : "Arduino disconnected"} />
            <button className="btn xsmall" onClick={() => fetch(`${apiBase}/control/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })}>connect</button>
            <button className="btn xsmall stop" onClick={() => fetch(`${apiBase}/control/disconnect`, { method: "POST" })}>disc</button>
          </div>
        </div>
        <Joystick onCmd={cmd} />
        <div className="mode-actions" aria-label="Roomba cleaning controls">
          <button className="btn small" onClick={() => cmd("clean")}>掃除開始</button>
          <button className="btn small" onClick={() => cmd("pause")}>一時停止</button>
          <button className="btn small" onClick={() => cmd("dock")}>ホームへ</button>
        </div>
      </div>

      <section className="panel sensor-panel" aria-live="polite">
        <div className="panel-head">
          <h2>Roomba status</h2>
          <small>{bridge.sensor_ts ? "live" : "no sensor data"}</small>
        </div>
        <div className="sensor-grid">
          <Sensor label="Battery" value={batteryText(bridge.sensor)} />
          <Sensor label="Charging" value={chargingText(bridge.sensor.charging_state)} />
          <Sensor label="Bumper" value={hazardText(bridge.sensor.bump_left, bridge.sensor.bump_right)} />
          <Sensor label="Wall / cliff" value={wallText(bridge.sensor.wall, bridge.sensor.cliff)} />
        </div>
        {bridge.error && <small className="sensor-error">bridge: {bridge.error}</small>}
      </section>

      <EegTriggerPanel apiBase={apiBase} decisionState={state.decisionState} />

      <AutopilotPanel apiBase={apiBase} layout="horizontal" />

      <div className="panel cmds-panel">
        <div className="panel-head">
          <h2>Recent</h2>
          <small>{lastCmds.length === 0 ? "none yet" : `${history.length} total`}</small>
        </div>
        <div className="cmd-strip">
          {lastCmds.length === 0 && <span className="cmd-strip-empty">—</span>}
          {lastCmds.map((c, i) => (
            <span key={i} className={`cmd-chip ${c.ok ? "" : "bad"}`} title={new Date(c.ts * 1000).toLocaleTimeString()}>
              {c.cmd}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Sensor({ label, value }: { label: string; value: string }) {
  return <div className="sensor-item"><small>{label}</small><strong>{value}</strong></div>;
}

function batteryText(s: Record<string, number | boolean>) {
  const voltage = s.voltage_mv;
  const charge = s.charge_mah;
  const capacity = s.capacity_mah;
  const percent = typeof charge === "number" && typeof capacity === "number" && capacity > 0 ? Math.round((charge / capacity) * 100) : null;
  if (percent !== null) return `${percent}%${typeof voltage === "number" ? ` · ${(voltage / 1000).toFixed(1)}V` : ""}`;
  return typeof voltage === "number" && voltage >= 0 ? `${(voltage / 1000).toFixed(1)}V` : "—";
}

function chargingText(value: number | boolean | undefined) {
  const labels: Record<number, string> = { 0: "not charging", 1: "recovery", 2: "charging", 3: "trickle", 4: "waiting", 5: "fault" };
  return typeof value === "number" && value >= 0 ? (labels[value] ?? `state ${value}`) : "—";
}

function hazardText(left: number | boolean | undefined, right: number | boolean | undefined) {
  if (left === undefined && right === undefined) return "—";
  return left || right ? "contact detected" : "clear";
}

function wallText(wall: number | boolean | undefined, cliff: number | boolean | undefined) {
  if (wall === undefined && cliff === undefined) return "—";
  if (cliff) return "cliff detected";
  return wall ? "wall detected" : "clear";
}
