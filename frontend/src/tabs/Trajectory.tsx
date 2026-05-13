import { useMemo } from "react";
import { TrajectoryStep } from "../types";

export interface TrajectoryTabProps {
  history: TrajectoryStep[];
}

interface Point { x: number; y: number; heading: number; t: number; cmd: string; ok: boolean }

const STEP_LEN = 12;         // SVG units per "forward" tick
const TURN_DEG = 30;         // degrees per turn command

function buildPath(history: TrajectoryStep[]): Point[] {
  const out: Point[] = [];
  let x = 0, y = 0, heading = -90; // facing up (-y is up in SVG, so heading -90 = +y up)
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

export function Trajectory({ history }: TrajectoryTabProps) {
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

  const lastCmds = history.slice(-8).reverse();
  const last = path[path.length - 1];

  return (
    <div className="traj-wrap">
      <div className="panel">
        <div className="panel-head">
          <h2>Roomba trajectory (dead-reckoned)</h2>
          <small>{history.length} events</small>
        </div>
        <div className="traj-canvas">
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ aspectRatio: w / h, background: "var(--surface-2)", borderRadius: 6 }}>
            {Array.from({ length: Math.ceil(w / 40) + 1 }).map((_, i) => (
              <line key={`v${i}`} x1={i * 40} y1={0} x2={i * 40} y2={h} stroke="var(--border)" strokeWidth={1} opacity={0.4} />
            ))}
            {Array.from({ length: Math.ceil(h / 40) + 1 }).map((_, i) => (
              <line key={`h${i}`} x1={0} y1={i * 40} x2={w} y2={i * 40} stroke="var(--border)" strokeWidth={1} opacity={0.4} />
            ))}

            <circle cx={cx} cy={cy} r={5} fill="var(--ok)" stroke="var(--bg)" strokeWidth={2} />
            <text x={cx + 10} y={cy + 4} fontSize={11} fill="var(--muted)">start</text>

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
        <div className="traj-meta">
          <small>+forward = direction of nose. Step length and turn angle are illustrative (no odometry from Roomba).</small>
        </div>
      </div>

      <div className="panel">
        <h2>Recent commands</h2>
        <table className="cmd-table">
          <thead><tr><th>time</th><th>cmd</th><th>result</th></tr></thead>
          <tbody>
            {lastCmds.length === 0 && <tr><td colSpan={3} style={{ color: "var(--muted)" }}>(none yet)</td></tr>}
            {lastCmds.map((c, i) => (
              <tr key={i}>
                <td>{new Date(c.ts * 1000).toLocaleTimeString()}</td>
                <td><span className={`cmd-tag ${c.cmd}`}>{c.cmd}</span></td>
                <td>{c.ok ? <span className="pill ok">ok</span> : <span className="pill bad">err</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
