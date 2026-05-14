import { useMemo } from "react";
import { TrajectoryStep } from "../types";

interface Props {
  history: TrajectoryStep[];
  compact?: boolean;
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

/**
 * Dead-reckoned trajectory map driven by the roomba/cmd event stream.
 * Each cmd advances a SVG turtle by STEP_LEN, scaled by the gap since
 * the previous event so a long forward looks longer than a short one.
 */
export function TrajectoryMap({ history, compact }: Props) {
  const { path, w, h, cx, cy, last, lastEventAgoSec } = useMemo(() => {
    const path = buildPath(history);
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
    const lastEventTs = history[history.length - 1]?.ts ?? 0;
    const lastEventAgoSec = lastEventTs ? Math.max(0, Date.now() / 1000 - lastEventTs) : null;
    return { path, w, h, cx, cy, last, lastEventAgoSec };
  }, [history]);

  return (
    <div className={`panel traj-map-panel ${compact ? "traj-map-compact" : ""}`}>
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
  );
}
