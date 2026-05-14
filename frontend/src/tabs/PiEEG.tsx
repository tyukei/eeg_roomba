import { lazy, Suspense, useMemo, useRef, useState } from "react";
import uPlot from "uplot";

import { AnalyzePanel } from "../components/AnalyzePanel";
import { AutoChart } from "../components/AutoChart";
import { BandHeatmap } from "../components/BandHeatmap";
import { BandsGrid } from "../components/BandsGrid";
import { BrainSvg } from "../components/BrainSvg";
import { ChannelGrid } from "../components/ChannelGrid";
import { CorrelationMatrix } from "../components/CorrelationMatrix";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ExpandablePanel } from "../components/ExpandablePanel";
import { TimeChannelHeatmap } from "../components/TimeChannelHeatmap";
import { corrMatrix, welch } from "../fft";
import { formatSI } from "../format";
import { MONTAGE } from "../montage";
import { themeColors } from "../theme";
import {
  AppState, BAND_COLORS, BAND_NAMES, BAND_RANGES, BandName,
  LIVE_HZ, NCH,
} from "../types";

// three.js is ~500KB minified; defer it until the user opens the PiEEG tab
// so the initial bundle stays lean for the Live/Roomba tabs.
const BrainParticles3D = lazy(() => import("../components/BrainParticles3D"));

// Force a log-axis to show only powers of ten — uPlot otherwise emits a tick
// for every minor (2,3,…,9) which makes Y labels overlap on a tall axis.
const decadeSplits = (_u: uPlot, _idx: number, lo: number, hi: number): number[] => {
  const out: number[] = [];
  let v = Math.pow(10, Math.floor(Math.log10(Math.max(1, lo))));
  let guard = 0;
  while (v <= hi * 1.0001 && guard++ < 40) { out.push(v); v *= 10; }
  return out.length ? out : [1];
};

export interface PiEEGTabProps {
  state: AppState;
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  bandsBuf: React.MutableRefObject<{ ts: number[]; bands: Record<BandName, number[][]> }>;
  tick: number;
  apiBase: string;
}

export function PiEEG({ state, liveBuf, bandsBuf, tick, apiBase }: PiEEGTabProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ch, setCh] = useState(6);
  const [band, setBand] = useState<BandName>("alpha");
  const [scale, setScale] = useState<"linear" | "log">("log");
  // Channel under the user's pointer in *any* panel (3D brain, heatmap,
  // sparkline grid, …). Lifted here so hovering one panel highlights the
  // same channel everywhere — turns the dashboard into a single linked view.
  const [hoveredCh, setHoveredCh] = useState<number | null>(null);

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

  const bandsOpts = useMemo<Omit<uPlot.Options, "width">>(() => {
    const c = themeColors();
    return {
      height: 220,
      scales: { x: { time: true }, y: { auto: true, distr: scale === "log" ? 3 : 1 } },
      series: [
        {},
        ...BAND_NAMES.map((b) => ({ label: b, stroke: BAND_COLORS[b], width: 1.5 })),
      ],
      axes: [
        { stroke: c.muted, grid: { stroke: c.border, width: 1 }, ticks: { stroke: c.border } },
        {
          stroke: c.muted, grid: { stroke: c.border, width: 1 }, ticks: { stroke: c.border },
          size: 70, space: 38,
          ...(scale === "log" ? { splits: decadeSplits } : {}),
          values: (_u, splits) => splits.map((v) => formatSI(v)),
        },
      ],
      legend: { show: false },
    };
  }, [scale]);

  const psdData = useMemo<uPlot.AlignedData>(() => {
    const samples = lb.ch[ch];
    if (!samples || samples.length < 64) return [[], []] as any;
    const { freqs, psd } = welch(samples, LIVE_HZ, 64);
    return [Array.from(freqs), Array.from(psd)] as any;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lb.ts.length, ch]);

  const psdOpts = useMemo<Omit<uPlot.Options, "width">>(() => {
    const c = themeColors();
    return {
      height: 200,
      scales: { x: { time: false }, y: { auto: true, distr: 3 } },
      series: [
        { label: "f (Hz)" },
        { label: "PSD (μV²/Hz)", stroke: c.accent, width: 1.5 },
      ],
      axes: [
        { stroke: c.muted, grid: { stroke: c.border, width: 1 }, ticks: { stroke: c.border }, size: 36 },
        {
          stroke: c.muted, grid: { stroke: c.border, width: 1 }, ticks: { stroke: c.border },
          size: 58, space: 38,
          splits: decadeSplits,
          values: (_u, splits) => splits.map((v) => formatSI(v)),
        },
      ],
      legend: { show: false },
    };
  }, []);

  const corr = useMemo(() => {
    const chs = lb.ch;
    if (chs[0].length < 50) return Array.from({ length: NCH }, () => Array(NCH).fill(0));
    return corrMatrix(chs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lb.ts.length]);

  const bandsHere = BAND_NAMES.map((b) => ({ band: b as BandName, value: state.bandsNow[b][ch] ?? 0 }));
  const bandMax = Math.max(1, ...bandsHere.map((x) => x.value));

  const topoValues = state.bandsNow[band];

  // Cognitive metrics averaged over the decision channels (the ones the
  // user has marked as relevant for the α-based control loop).
  const decisionChs = state.threshold.channels.length ? state.threshold.channels : [6, 7];
  const meanOver = (arr: number[], chs: number[]) =>
    chs.reduce((s, c) => s + (arr[c] ?? 0), 0) / Math.max(1, chs.length);
  const meanAlpha = meanOver(state.bandsNow.alpha, decisionChs);
  const meanBeta  = meanOver(state.bandsNow.beta,  decisionChs);
  const meanTheta = meanOver(state.bandsNow.theta, decisionChs);
  const engagement = meanBeta / Math.max(1e-9, meanAlpha + meanTheta);
  const alphaBeta = meanAlpha / Math.max(1e-9, meanBeta);
  // Frontal alpha asymmetry: log10(α_right / α_left) using F4 (ch3) - F3 (ch2).
  // Davidson model: positive ≈ approach motivation, negative ≈ withdrawal.
  const f3Alpha = state.bandsNow.alpha[2] ?? 0;
  const f4Alpha = state.bandsNow.alpha[3] ?? 0;
  const frontalAsym = (f3Alpha > 0 && f4Alpha > 0)
    ? Math.log10(f4Alpha / f3Alpha)
    : NaN;

  const bandSelect = (
    <label className="small-label">band:
      <select value={band} onChange={(e) => setBand(e.target.value as BandName)}>
        {BAND_NAMES.map((b) => (<option key={b} value={b}>{b}</option>))}
      </select>
    </label>
  );

  return (
    <>
      <AnalyzePanel apiBase={apiBase} targetRef={wrapRef} />
      <div className="analysis-wrap" ref={wrapRef}>

        <ExpandablePanel
          title="Topography"
          dataPanel="Topography"
          headExtras={bandSelect}
        >
          <BrainSvg values={topoValues} selected={state.threshold.channels} />
          <div className="brain-meta">
            <small>color = {band} band power · decision chs highlighted</small>
          </div>
          <div className="electrode-table-wrap" style={{ marginTop: 14 }}>
            <table className="electrode-table">
              <thead>
                <tr><th>ch</th><th>label</th><th>region</th><th>{band}</th></tr>
              </thead>
              <tbody>
                {MONTAGE.map((e) => (
                  <tr
                    key={e.ch}
                    className={hoveredCh === e.ch ? "row-hovered" : ""}
                    onPointerEnter={() => setHoveredCh(e.ch)}
                    onPointerLeave={() => setHoveredCh(null)}
                  >
                    <td><strong>ch{e.ch}</strong></td>
                    <td>{e.name}</td>
                    <td><span className="region-chip">{e.region}</span></td>
                    <td>{formatSI(topoValues[e.ch] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ExpandablePanel>

        <ExpandablePanel
          title={<>3D Brain · {band}</>}
          subtitle="drag · auto-spin · hover to highlight"
          dataPanel="3D Brain"
          className="brain3d-panel"
        >
          <ErrorBoundary
            fallback={(err) => (
              <div className="brain3d-loading">3D brain failed to load: {err.message}</div>
            )}
          >
            <Suspense fallback={<div className="brain3d-loading">loading 3D brain…</div>}>
              <BrainParticles3D
                values={topoValues}
                band={band}
                hovered={hoveredCh}
                onHover={setHoveredCh}
                onSelect={(c) => setCh(c)}
              />
            </Suspense>
          </ErrorBoundary>
        </ExpandablePanel>

        <ExpandablePanel
          title={<>Bands · ch{ch}</>}
          dataPanel="Bands"
        >
          <div className="band-bars">
            {bandsHere.map((b) => (
              <div className="band-bar" key={b.band}>
                <div className="band-bar-fill" style={{ height: `${(b.value / bandMax) * 100}%`, background: BAND_COLORS[b.band] }} />
                <div className="band-bar-label">
                  <strong>{b.band}</strong>
                  <small>{BAND_RANGES[b.band][0]}-{BAND_RANGES[b.band][1]}Hz</small>
                  <span>{formatSI(b.value)}</span>
                </div>
              </div>
            ))}
          </div>
        </ExpandablePanel>

        <ExpandablePanel
          title={<>PSD · ch{ch}</>}
          subtitle="Welch · 10s · log y"
          dataPanel="PSD"
        >
          <AutoChart baseOpts={psdOpts} data={psdData} />
        </ExpandablePanel>

        <ExpandablePanel
          title="Cognitive metrics"
          subtitle={`decision chs ${decisionChs.map((c) => `ch${c}`).join(", ")} · frontal asym F3/F4`}
          dataPanel="Cognitive metrics"
        >
          <div className="cog-grid">
            <Stat label="Engagement"
                  value={engagement.toFixed(2)}
                  hint="β / (α + θ) · ↑ focus, ↓ relax" />
            <Stat label="α / β"
                  value={alphaBeta.toFixed(2)}
                  hint="↑ relaxed, ↓ alert" />
            <Stat label="Frontal α asym"
                  value={isNaN(frontalAsym) ? "—" : frontalAsym.toFixed(3)}
                  hint="log₁₀(F4/F3) · + approach / − withdrawal" />
            <Stat label="α (decision chs)"
                  value={formatSI(meanAlpha)}
                  hint={`mean over ${decisionChs.length} ch`} />
            <Stat label="β (decision chs)"
                  value={formatSI(meanBeta)}
                  hint={`mean over ${decisionChs.length} ch`} />
            <Stat label="θ (decision chs)"
                  value={formatSI(meanTheta)}
                  hint={`mean over ${decisionChs.length} ch`} />
          </div>
        </ExpandablePanel>

        <ExpandablePanel
          title="Channel × Band heatmap"
          subtitle="per-band normalised"
          dataPanel="Channel × Band heatmap"
        >
          <BandHeatmap state={state} hovered={hoveredCh} onHover={setHoveredCh} />
        </ExpandablePanel>

        <ExpandablePanel
          title="Channel correlation · 10s"
          subtitle="Pearson r · ±1 = synced"
          dataPanel="Channel correlation"
        >
          <CorrelationMatrix matrix={corr} selected={state.threshold.channels} />
        </ExpandablePanel>

        {/* ----- wide panels at the bottom — these break the column flow
                  with `column-span: all` and stack as full-width bands.
                  Grouped here so the narrow tiles above form one coherent
                  masonry block rather than getting split by mid-list wides. */}

        <ExpandablePanel
          title="Band power · 60s"
          dataPanel="Band power 60s"
          wide
          headExtras={(
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
          )}
        >
          <div className="chart"><AutoChart baseOpts={bandsOpts} data={bandsData} /></div>
        </ExpandablePanel>

        <ExpandablePanel
          title="EEG live (16ch)"
          subtitle="10s window · hover to highlight"
          dataPanel="EEG live"
          wide
        >
          <ChannelGrid
            liveBuf={liveBuf}
            selected={state.threshold.channels}
            tick={tick}
            hovered={hoveredCh}
            onHover={setHoveredCh}
          />
        </ExpandablePanel>

        <ExpandablePanel
          title={<>Time × Channel · {band}</>}
          subtitle="60s history · newest on the right"
          dataPanel="Time × Channel heatmap"
          wide
        >
          <TimeChannelHeatmap
            bandsBuf={bandsBuf}
            band={band}
            tick={tick}
            hovered={hoveredCh}
            onHover={setHoveredCh}
          />
        </ExpandablePanel>

        <ExpandablePanel
          title="Per-channel bands"
          subtitle="δ θ α β γ from left · each ch normalised"
          dataPanel="Per-channel bands"
          wide
        >
          <BandsGrid
            state={state}
            selected={state.threshold.channels}
            hovered={hoveredCh}
            onHover={setHoveredCh}
          />
        </ExpandablePanel>

      </div>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="cog-stat">
      <div className="cog-stat-label">{label}</div>
      <div className="cog-stat-value">{value}</div>
      <div className="cog-stat-hint">{hint}</div>
    </div>
  );
}
