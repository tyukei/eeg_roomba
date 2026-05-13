import { useMemo, useState } from "react";
import UplotReact from "uplot-react";
import uPlot from "uplot";

import { BrainSvg } from "../components/BrainSvg";
import { CorrelationMatrix } from "../components/CorrelationMatrix";
import { corrMatrix, welch } from "../fft";
import { MONTAGE, REGION_COLORS } from "../montage";
import {
  AppState, BAND_COLORS, BAND_NAMES, BAND_RANGES, BandName,
  LIVE_HZ, NCH,
} from "../types";

export interface AnalysisTabProps {
  state: AppState;
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  bandsBuf: React.MutableRefObject<{ ts: number[]; bands: Record<BandName, number[][]> }>;
  tick: number;
}

export function Analysis({ state, liveBuf, bandsBuf, tick }: AnalysisTabProps) {
  void tick;
  const [ch, setCh] = useState(6);
  const [band, setBand] = useState<BandName>("alpha");
  const [scale, setScale] = useState<"linear" | "log">("log");

  const lb = liveBuf.current;
  const bb = bandsBuf.current;

  const bandsData = useMemo<uPlot.AlignedData>(() => {
    if (bb.ts.length === 0) return [[], [], [], [], [], []] as any;
    return [
      bb.ts.slice(),
      ...BAND_NAMES.map((b) => bb.bands[b][ch].slice()),
    ] as any;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bb.ts.length, bb.ts[bb.ts.length - 1], ch]);

  const bandsOpts = useMemo<uPlot.Options>(() => ({
    width: 900, height: 280,
    scales: { x: { time: true }, y: { auto: true, distr: scale === "log" ? 3 : 1 } },
    series: [
      {},
      ...BAND_NAMES.map((b) => ({ label: b, stroke: BAND_COLORS[b], width: 1.5 })),
    ],
    axes: [
      { stroke: "#9aa3b2", grid: { stroke: "#1d2330", width: 1 }, ticks: { stroke: "#2a2f38" } },
      { stroke: "#9aa3b2", grid: { stroke: "#1d2330", width: 1 }, ticks: { stroke: "#2a2f38" }, size: 110 },
    ],
    legend: { show: false },
  }), [scale]);

  const psdData = useMemo<uPlot.AlignedData>(() => {
    const samples = lb.ch[ch];
    if (!samples || samples.length < 64) return [[], []] as any;
    const { freqs, psd } = welch(samples, LIVE_HZ, 64);
    return [Array.from(freqs), Array.from(psd)] as any;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lb.ts.length, ch]);

  const psdOpts = useMemo<uPlot.Options>(() => ({
    width: 500, height: 240,
    scales: { x: { time: false }, y: { auto: true, distr: 3 } },
    series: [
      { label: "f (Hz)" },
      { label: "PSD (μV²/Hz)", stroke: "#60a5fa", width: 1.5 },
    ],
    axes: [
      { stroke: "#9aa3b2", grid: { stroke: "#1d2330", width: 1 }, ticks: { stroke: "#2a2f38" }, size: 36 },
      { stroke: "#9aa3b2", grid: { stroke: "#1d2330", width: 1 }, ticks: { stroke: "#2a2f38" }, size: 90 },
    ],
    legend: { show: false },
  }), []);

  const corr = useMemo(() => {
    const chs = lb.ch;
    if (chs[0].length < 50) return Array.from({ length: NCH }, () => Array(NCH).fill(0));
    return corrMatrix(chs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lb.ts.length]);

  const bandsHere = BAND_NAMES.map((b) => ({ band: b as BandName, value: state.bandsNow[b][ch] ?? 0 }));
  const bandMax = Math.max(1, ...bandsHere.map((x) => x.value));

  const topoValues = state.bandsNow[band];

  return (
    <div className="analysis-wrap">
      <div className="panel">
        <div className="panel-head">
          <h2>Brain topography</h2>
          <label className="small-label">band:
            <select value={band} onChange={(e) => setBand(e.target.value as BandName)}>
              {BAND_NAMES.map((b) => (<option key={b} value={b}>{b}</option>))}
            </select>
          </label>
        </div>
        <BrainSvg values={topoValues} selected={state.threshold.channels} />
        <div className="brain-meta">
          <small>color = current {band} band power · decision chs highlighted</small>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Channel → 10-20</h2></div>
        <table className="electrode-table">
          <thead>
            <tr><th>ch</th><th>label</th><th>region</th><th>{band}</th></tr>
          </thead>
          <tbody>
            {MONTAGE.map((e) => (
              <tr key={e.ch}>
                <td><strong>ch{e.ch}</strong></td>
                <td>{e.name}</td>
                <td><span className="region-chip" style={{ background: REGION_COLORS[e.region] }}>{e.region}</span></td>
                <td>{(topoValues[e.ch] ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel full">
        <div className="panel-head">
          <h2>Band power · 60s</h2>
          <div className="row" style={{ gap: 8 }}>
            <label className="small-label">ch:
              <select value={ch} onChange={(e) => setCh(Number(e.target.value))}>
                {Array.from({ length: NCH }, (_, i) => (<option key={i} value={i}>ch{i}</option>))}
              </select>
            </label>
            <label className="small-label">y:
              <select value={scale} onChange={(e) => setScale(e.target.value as any)}>
                <option value="linear">linear</option>
                <option value="log">log</option>
              </select>
            </label>
          </div>
        </div>
        <div className="chart"><UplotReact options={bandsOpts} data={bandsData} /></div>
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
          <h2>PSD · ch{ch}</h2>
          <small>Welch · 10s · log y</small>
        </div>
        <div style={{ width: "100%", height: 240 }}>
          <UplotReact options={psdOpts} data={psdData} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Band powers · ch{ch}</h2></div>
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

      <div className="panel full">
        <div className="panel-head">
          <h2>Channel correlation · 10s</h2>
          <small>Pearson r · ±1 = synced (common-mode noise indicator)</small>
        </div>
        <CorrelationMatrix matrix={corr} selected={state.threshold.channels} />
      </div>
    </div>
  );
}
