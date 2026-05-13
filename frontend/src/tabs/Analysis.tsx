import { useMemo, useState } from "react";
import UplotReact from "uplot-react";
import uPlot from "uplot";

import { CorrelationMatrix } from "../components/CorrelationMatrix";
import { corrMatrix, welch } from "../fft";
import {
  AppState, BAND_COLORS, BAND_NAMES, BAND_RANGES, BandName,
  LIVE_HZ, NCH,
} from "../types";

export interface AnalysisTabProps {
  state: AppState;
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  tick: number;
}

export function Analysis({ state, liveBuf, tick }: AnalysisTabProps) {
  void tick;
  const [ch, setCh] = useState(6);

  // Channel correlation matrix from current 10s buffer.
  const corr = useMemo(() => {
    const chs = liveBuf.current.ch;
    if (chs[0].length < 50) return Array.from({ length: NCH }, () => Array(NCH).fill(0));
    return corrMatrix(chs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBuf.current.ts.length]);

  // PSD via Welch from current 10s buffer for the selected channel.
  const psdData = useMemo<uPlot.AlignedData>(() => {
    const samples = liveBuf.current.ch[ch];
    if (!samples || samples.length < 64) return [[], []] as any;
    const { freqs, psd } = welch(samples, LIVE_HZ, 64);
    return [Array.from(freqs), Array.from(psd)] as any;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBuf.current.ts.length, ch]);

  const psdOpts = useMemo<uPlot.Options>(() => ({
    width: 600, height: 260,
    scales: { x: { time: false }, y: { auto: true, distr: 3 } },
    series: [
      { label: "f (Hz)" },
      { label: "PSD (μV²/Hz)", stroke: "#60a5fa", width: 1.5 },
    ],
    axes: [{ size: 36 }, { size: 60 }],
    legend: { show: true },
  }), []);

  // Current band powers for selected channel (bar chart).
  const bandsHere = BAND_NAMES.map((b) => ({ band: b as BandName, value: state.bandsNow[b][ch] ?? 0 }));
  const bandMax = Math.max(1, ...bandsHere.map((x) => x.value));

  return (
    <div className="analysis-wrap">
      <div className="panel">
        <div className="panel-head">
          <h2>Band powers · ch{ch}</h2>
          <label className="small-label">ch:
            <select value={ch} onChange={(e) => setCh(Number(e.target.value))}>
              {Array.from({ length: NCH }, (_, i) => (
                <option key={i} value={i}>ch{i}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="band-bars">
          {bandsHere.map((b) => (
            <div className="band-bar" key={b.band}>
              <div className="band-bar-fill" style={{ height: `${(b.value / bandMax) * 100}%`, background: BAND_COLORS[b.band] }} />
              <div className="band-bar-label">
                <strong style={{ color: BAND_COLORS[b.band] }}>{b.band}</strong>
                <small>{BAND_RANGES[b.band][0]}-{BAND_RANGES[b.band][1]}Hz</small>
                <span>{b.value.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>PSD · ch{ch}</h2>
          <small>Welch from 10s live buffer · log y · 50Hz nyquist=25</small>
        </div>
        <div style={{ width: "100%", height: 260 }}>
          <UplotReact options={psdOpts} data={psdData} />
        </div>
        <div className="band-legend">
          {BAND_NAMES.map((b) => (
            <span key={b} className="band-chip" style={{ borderColor: BAND_COLORS[b] }}>
              <span className="band-swatch" style={{ background: BAND_COLORS[b] }} />
              <strong>{b}</strong>
              <small>{BAND_RANGES[b][0]}-{BAND_RANGES[b][1]}Hz</small>
            </span>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Channel correlation · 10s</h2>
          <small>Pearson r · live samples · ±1 = synced (suggests common-mode noise)</small>
        </div>
        <CorrelationMatrix matrix={corr} selected={state.threshold.channels} />
      </div>
    </div>
  );
}
