import { useMemo, useState } from "react";

import { AutopilotPanel } from "../components/AutopilotPanel";
import { EegTriggerPanel } from "../components/EegTriggerPanel";
import { EmergencyStop } from "../components/EmergencyStop";
import { Joystick } from "../components/Joystick";
import { AppState, TrajectoryStep } from "../types";

export interface RoombaTabProps {
  state: AppState;
  history: TrajectoryStep[];
  apiBase: string;
  camOn: boolean;
  setCamOn: (v: boolean) => void;
}

interface Point { x: number; y: number; heading: number; t: number; cmd: string; ok: boolean }

const STEP_LEN = 12;         // SVG units per "forward" tick
const TURN_DEG = 30;         // degrees per turn command

function buildPath(history: TrajectoryStep[]): Point[] {
  const out: Point[] = [];
  let x = 0, y = 0, heading = -90;
  let prevTs = history[0]?.ts ?? 0;
  for (const ev of history) {
    if (!ev.ok) continue;
    const dt = Math.max(0, ev.ts - prevTs);
    prevTs = ev.ts;
    switch (ev.cmd) {
      case "forward":
      case "back": {
        const dir = ev.cmd === "forward" ? 1 : -1;
        const len = STEP_LEN * Math.max(0.5, Math.min(3, dt));
        const rad = (heading * Math.PI) / 180;
        x += dir * len * Math.cos(rad);
        y += dir * len * Math.sin(rad);
        break;
      }
      case "left": heading -= TURN_DEG; break;
      case "right": heading += TURN_DEG; break;
      case "stop": break;
    }
    out.push({ x, y, heading, t: ev.ts, cmd: ev.cmd, ok: ev.ok });
  }
  return out;
}

export function Roomba({ state, history, apiBase, camOn, setCamOn }: RoombaTabProps) {
  const [camKey, setCamKey] = useState(0);
  const [camStatus, setCamStatus] = useState<"idle" | "loading" | "live" | "error">(
    camOn ? "loading" : "idle"
  );

  const cmd = (c: string) => {
    fetch(`${apiBase}/control/${c}`, { method: "POST" }).catch(() => {});
  };

  const path = useMemo(() => buildPath(history), [history]);
  let minX = -100, maxX = 100, minY = -100, maxY = 100;
  for (const p of path) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(200, maxX - minX + 40);
  const h = Math.max(200, maxY - minY + 40);
  const cx = -(minX - 20);
  const cy = -(minY - 20);
  const last = path[path.length - 1];
  const lastCmds = history.slice(-12).reverse();
  const lastEventTs = history[history.length - 1]?.ts ?? 0;
  const lastEventAgoSec = lastEventTs ? Math.max(0, Date.now() / 1000 - lastEventTs) : null;

  return (
    <div className="roomba-wrap compact">
      <EmergencyStop apiBase={apiBase} />

      <div className="panel cam-panel">
        <div className="panel-head">
          <h2>Camera</h2>
          <div className="cam-controls">
            <button className="btn small" onClick={async () => {
              setCamStatus("loading");
              await fetch(`${apiBase}/camera/start`, { method: "POST" }).catch(() => {});
              setCamKey((k) => k + 1);
              setCamOn(true);
            }}>Start</button>
            <button className="btn small stop" onClick={async () => {
              setCamOn(false);
              setCamStatus("idle");
              await fetch(`${apiBase}/camera/stop`, { method: "POST" }).catch(() => {});
            }}>Stop</button>
          </div>
        </div>
        <div className="cam-area">
          {camOn ? (
            <>
              <img src={`${apiBase}/camera/stream?t=${camKey}`} alt="camera" key={`cam-${camKey}`}
                   onLoad={() => setCamStatus("live")}
                   onError={() => setCamStatus("error")} />
              {camStatus !== "live" && (
                <div className="cam-overlay">
                  {camStatus === "error" ? "stream failed — try Stop then Start" : "connecting to camera…"}
                </div>
              )}
            </>
          ) : (
            <div className="cam-overlay">press Start to begin preview</div>
          )}
        </div>
      </div>

      <div className="panel traj-map-panel">
        <div className="panel-head">
          <h2>Trajectory</h2>
          <small>
            {history.length} events
            {lastEventAgoSec !== null && (
              <> · {lastEventAgoSec < 2 ? "now" : `${Math.floor(lastEventAgoSec)}s ago`}</>
            )}
          </small>
        </div>
        <div className="traj-canvas">
          <svg viewBox={`0 0 ${w} ${h}`} width="100%"
               style={{ aspectRatio: w / h, background: "var(--surface-2)", borderRadius: 6 }}>
            {Array.from({ length: Math.ceil(w / 40) + 1 }).map((_, i) => (
              <line key={`v${i}`} x1={i * 40} y1={0} x2={i * 40} y2={h} stroke="var(--border)" strokeWidth={1} opacity={0.4} />
            ))}
            {Array.from({ length: Math.ceil(h / 40) + 1 }).map((_, i) => (
              <line key={`h${i}`} x1={0} y1={i * 40} x2={w} y2={i * 40} stroke="var(--border)" strokeWidth={1} opacity={0.4} />
            ))}
            <circle cx={cx} cy={cy} r={5} fill="var(--ok)" stroke="var(--bg)" strokeWidth={2} />
            {path.length > 1 && (
              <polyline
                points={path.map((p) => `${p.x + cx},${p.y + cy}`).join(" ")}
                fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round"
              />
            )}
            {last && (
              <g transform={`translate(${last.x + cx}, ${last.y + cy}) rotate(${last.heading + 90})`}>
                <polygon points="-7,7 7,7 0,-10" fill="var(--bad)" stroke="var(--bg)" strokeWidth={1.5} />
              </g>
            )}
          </svg>
        </div>
      </div>

      <div className="panel ctrl-panel">
        <div className="panel-head">
          <h2>Control</h2>
          <div className="ctrl-conn">
            <button className="btn xsmall" onClick={() => fetch(`${apiBase}/control/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })}>conn</button>
            <button className="btn xsmall stop" onClick={() => fetch(`${apiBase}/control/disconnect`, { method: "POST" })}>disc</button>
          </div>
        </div>
        <Joystick onCmd={cmd} />
      </div>

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
