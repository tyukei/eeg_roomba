import { ChannelGrid } from "../components/ChannelGrid";
import { Slider } from "../components/Slider";
import { formatSI } from "../format";
import { AppState, Threshold } from "../types";

export interface LiveTabProps {
  state: AppState;
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  tick: number;            // 200ms force-render counter, just to trigger re-render
  setThresh: (patch: Partial<Threshold>) => void;
}

export function Live({ state, liveBuf, tick, setThresh }: LiveTabProps) {
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
    <div className="app">
      <div className="panel main-panel">
        {/* Big demo indicator — the whole point of the system in one glance */}
        <div className={`decision-hero decision-${state.decisionState}`}>
          <div className="decision-hero-label">Decision</div>
          <div className="decision-hero-state">{state.decisionState.toUpperCase()}</div>
          <div className="decision-hero-sub">{decisionLine}</div>
        </div>

        <div className="panel-head" style={{ marginTop: 16 }}>
          <h2>EEG live (16ch)</h2>
          <small>10s window · each ch auto-scaled · decision chs accented</small>
        </div>
        {buf.ts.length === 0 ? (
          <div className="chart-empty">
            <div className="chart-empty-title">Waiting for PiEEG data…</div>
            <small>
              {state.pieegOnline
                ? "Acquirer is online · stream starting"
                : "WS connected — start pieeg.service on Pi-A to see the signal"}
            </small>
          </div>
        ) : (
          <ChannelGrid liveBuf={liveBuf} selected={selectedChs} tick={tick} />
        )}

        <div className="panel-head" style={{ marginTop: 16 }}>
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

      <div className="side">
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
