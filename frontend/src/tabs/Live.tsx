import { lazy, Suspense } from "react";

import { CameraView } from "../components/CameraView";
import { ChannelGrid } from "../components/ChannelGrid";
import { HeartRate } from "../components/HeartRate";
import { MindState } from "../components/MindState";
import { Slider } from "../components/Slider";
import { TrajectoryMap } from "../components/TrajectoryMap";
import { formatSI } from "../format";
import { AppState, BandName, Threshold, TrajectoryStep } from "../types";

// three.js lives in its own chunk via BrainParticles3D already; reuse the
// same lazy boundary for MindTrajectory3D so the initial bundle stays slim.
const MindTrajectory3D = lazy(() => import("../components/MindTrajectory3D"));

export interface LiveTabProps {
  state: AppState;
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  bandsBuf: React.MutableRefObject<{ ts: number[]; bands: Record<BandName, number[][]> }>;
  tick: number;            // 200ms force-render counter, just to trigger re-render
  setThresh: (patch: Partial<Threshold>) => void;
  apiBase: string;
  trajHistory: TrajectoryStep[];
  camOn: boolean;
  setCamOn: (v: boolean) => void;
}

export function Live({
  state, liveBuf, bandsBuf, tick, setThresh,
  apiBase, trajHistory, camOn, setCamOn,
}: LiveTabProps) {
  const buf = liveBuf.current;
  const selectedChs = state.threshold.channels;

  const curAlpha = selectedChs.length
    ? selectedChs.reduce((a, c) => a + (state.bandsNow.alpha[c] ?? 0), 0) / selectedChs.length
    : 0;
  const zone = curAlpha >= state.threshold.enter ? "high"
    : curAlpha <= state.threshold.exit ? "low" : "mid";

  const alphaArr = state.bandsNow.alpha;
  const maxAlpha = Math.max(1, ...alphaArr);

  // Demo-readable text for the big indicator.
  const decisionLine = state.decisionState === "active"
    ? "Roomba moving"
    : "Roomba idle";

  return (
    <div className="live-wrap">
      {/* Top banner spans all three columns — the demo cares most about
          this one piece of state, so it stays unmissable. */}
      <div className={`decision-hero decision-${state.decisionState}`}>
        <div className="decision-hero-label">Decision</div>
        <div className="decision-hero-state">{state.decisionState.toUpperCase()}</div>
        <div className="decision-hero-sub">{decisionLine}</div>
      </div>

      {/* Column 1 — raw biometric signals: EEG live, α power, heart rate.
       * HR lives here (not in col 2 with derived cognitive metrics)
       * because the BCG-derived BPM is a direct signal from the same
       * EEG stream, not a derived index. */}
      <div className="live-col">
        <div className="panel">
          <div className="panel-head">
            <h2>EEG live (16ch)</h2>
            <small>10s · decision chs accented</small>
          </div>
          {buf.ts.length === 0 ? (
            <div className="chart-empty">
              <div className="chart-empty-title">Waiting for PiEEG data…</div>
              <small>
                {state.pieegOnline
                  ? "Acquirer is online · stream starting"
                  : "WS connected — start pieeg.service on Pi-A"}
              </small>
            </div>
          ) : (
            <ChannelGrid liveBuf={liveBuf} selected={selectedChs} tick={tick} />
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>α band power</h2>
            <small>decision: ch{selectedChs.join(", ch")}</small>
          </div>
          <div className="alpha-bars">
            {alphaArr.map((v, i) => (
              <div className={`bar ${selectedChs.includes(i) ? "selected" : ""}`} key={i} title={v.toFixed(2)}>
                <div style={{ height: `${Math.min(100, (v / maxAlpha) * 100)}%` }} />
                <span>ch{i}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Heart rate</h2>
            <small>EEG-derived</small>
          </div>
          <HeartRate liveBuf={liveBuf} tick={tick} />
        </div>
      </div>

      {/* Column 2 — derived cognitive metrics (Mind state + 3D trajectory). */}
      <div className="live-col">
        <div className="panel">
          <div className="panel-head">
            <h2>Mind state</h2>
            <small>集中 vs リラックス · 60s 推移</small>
          </div>
          <MindState state={state} bandsBuf={bandsBuf} tick={tick} />
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Mind space · 3D</h2>
            <small>focus × relax × time</small>
          </div>
          <Suspense fallback={<div className="mind3d-loading">3D loading…</div>}>
            <MindTrajectory3D bandsBuf={bandsBuf} tick={tick} />
          </Suspense>
        </div>
      </div>

      {/* Column 3 — Roomba context (camera + map + thresholds). */}
      <div className="live-col">
        <CameraView apiBase={apiBase} camOn={camOn} setCamOn={setCamOn} compact />

        <TrajectoryMap history={trajHistory} compact />

        <div className="panel">
          <div className="panel-head">
            <h2>Thresholds</h2>
            <span className={`alpha-now ${zone}`}>α {formatSI(curAlpha)}</span>
          </div>
          <Slider label="enter" min={0} max={50} step={0.5}
            value={state.threshold.enter} onChange={(v) => setThresh({ enter: v })} hint="α ≥ enter で active" />
          <Slider label="exit" min={0} max={50} step={0.5}
            value={state.threshold.exit} onChange={(v) => setThresh({ exit: v })} hint="α ≤ exit で idle" />
          <Slider label="dwell" min={0} max={3000} step={50} unit="ms"
            value={state.threshold.dwell_ms} onChange={(v) => setThresh({ dwell_ms: v })} hint="連続超過時間" />
        </div>
      </div>
    </div>
  );
}
