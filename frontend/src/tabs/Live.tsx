import { useMemo } from "react";
import uPlot from "uplot";

import { AutoChart } from "../components/AutoChart";
import { Slider } from "../components/Slider";
import { formatSI } from "../format";
import { themeColors } from "../theme";
import { NCH, LIVE_BUF_SEC, LIVE_HZ, AppState, Threshold } from "../types";

export interface LiveTabProps {
  state: AppState;
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  tick: number;            // 200ms force-render counter, just to trigger re-render
  setThresh: (patch: Partial<Threshold>) => void;
}

export function Live({ state, liveBuf, tick, setThresh }: LiveTabProps) {
  void tick; // dep only

  const buf = liveBuf.current;
  const chartData = useMemo<uPlot.AlignedData>(() => {
    return [
      buf.ts.slice(),
      ...buf.ch.map((c) => {
        if (c.length === 0) return [];
        let sum = 0;
        for (const v of c) sum += v;
        const mean = sum / c.length;
        return c.map((v) => v - mean);
      }),
    ] as any;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf.ts.length, buf.ts[buf.ts.length - 1]]);

  const selectedChs = state.threshold.channels;

  const chartOpts = useMemo<Omit<uPlot.Options, "width">>(() => {
    const c = themeColors();
    return {
      height: 300,
      scales: { x: { time: true }, y: { auto: true } },
      series: [{}, ...Array.from({ length: NCH }, (_, i) => ({
        label: `ch${i}`,
        stroke: selectedChs.includes(i)
          ? c.accent
          : `hsl(212 14% ${48 + (i / (NCH - 1)) * 30}%)`,
        width: selectedChs.includes(i) ? 1.8 : 0.9,
      }))],
      axes: [
        { stroke: c.muted, grid: { stroke: c.border, width: 1 }, ticks: { stroke: c.border } },
        {
          stroke: c.muted, grid: { stroke: c.border, width: 1 }, ticks: { stroke: c.border },
          size: 60, space: 38,
          values: (_u, splits) => splits.map((v) => formatSI(v)),
        },
      ],
      legend: { show: false },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedChs.join(",")]);

  const curAlpha = selectedChs.length
    ? selectedChs.reduce((a, c) => a + (state.bandsNow.alpha[c] ?? 0), 0) / selectedChs.length
    : 0;
  const zone = curAlpha >= state.threshold.enter ? "high"
    : curAlpha <= state.threshold.exit ? "low" : "mid";

  const alphaArr = state.bandsNow.alpha;
  const maxAlpha = Math.max(1, ...alphaArr);

  void liveBuf; void LIVE_BUF_SEC; void LIVE_HZ;

  return (
    <div className="app">
      <div className="panel main-panel">
        <div className="panel-head">
          <h2>EEG live (16ch)</h2>
          <small>10s window · ch mean removed for display</small>
        </div>
        <div className="chart">
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
            <AutoChart baseOpts={chartOpts} data={chartData} />
          )}
        </div>

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
          <div className="panel-section">
            <h2>Status</h2>
            <div className="kv">
              <span>PiEEG<span className="kv-hint">{!state.pieegOnline && " — no acquirer data yet"}</span></span>
              <span className={`pill ${state.pieegOnline ? "ok" : "bad"}`}>{state.pieegOnline ? "online" : "offline"}</span>
            </div>
            <div className="kv"><span>Decision</span><span className={`pill ${state.decisionState}`}>{state.decisionState}</span></div>
            <div className="kv">
              <span>Roomba<span className="kv-hint">{!state.roombaOk && " — bridge offline"}</span></span>
              <span className={`pill ${state.roombaOk ? "ok" : "bad"}`}>{state.roombaOk ? "online" : "offline"}</span>
            </div>
          </div>
        </div>

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
