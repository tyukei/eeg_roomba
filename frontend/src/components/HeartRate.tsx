/**
 * Heart rate estimated from EEG via the BCG (ballistocardiogram) artifact.
 *
 * EEG electrodes pick up a small pulse-synchronous signal from blood flow
 * through scalp arteries — usually visible on frontal channels. Bandpass
 * 0.7-3 Hz, peak-pick on the envelope, then BPM = 60 / mean RR.
 *
 * Caveat: this is an artifact, not ECG. The estimate is noisy and only
 * works well when the subject is still and the BCG is strong. Display
 * the value with an honesty qualifier so demo viewers know it's not a
 * medical-grade reading.
 */
import { useMemo } from "react";
import { LIVE_HZ } from "../types";

interface Props {
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  tick: number;
}

const CH_PRIMARY = 0;    // Fp1 — frontal, typically the cleanest BCG
const CH_SECONDARY = 1;  // Fp2 — fallback if primary is bad
const MIN_BPM = 40;
const MAX_BPM = 180;
const MIN_PEAK_DIST = Math.floor((60 / MAX_BPM) * LIVE_HZ);  // ≈ 16 samples @ 50Hz
const MAX_PEAK_DIST = Math.ceil((60 / MIN_BPM) * LIVE_HZ);   // ≈ 75 samples @ 50Hz

// Centered moving average — used for both DC removal (subtract a wide
// window) and smoothing (subtract a narrow window). Simple and cheap.
function movingAvg(x: Float32Array | number[], win: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (win <= 1) {
    for (let i = 0; i < n; i++) out[i] = x[i];
    return out;
  }
  const half = Math.floor(win / 2);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += x[j];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

interface Estimate {
  bpm: number | null;
  peaks: number[];        // sample indices into the filtered series
  filtered: Float32Array; // same length as input window
  confidence: "low" | "ok" | "good";
}

function estimateBpm(signal: number[]): Estimate {
  const n = signal.length;
  if (n < LIVE_HZ * 4) {
    return { bpm: null, peaks: [], filtered: new Float32Array(n), confidence: "low" };
  }
  // Bandpass ≈ 0.7–5 Hz: subtract wide MA (removes <1 Hz drift), then
  // narrow MA smooths >5 Hz noise. Cheap zero-phase substitute for
  // a Butterworth biquad.
  const wide = movingAvg(signal, Math.floor(LIVE_HZ * 1.0));       // ~1 s window → cuts <1 Hz
  const detrended = new Float32Array(n);
  for (let i = 0; i < n; i++) detrended[i] = signal[i] - wide[i];
  const smoothed = movingAvg(detrended, 5);                         // ~5 sample LPF

  // Adaptive threshold from the trailing window stdev.
  let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) { sum += smoothed[i]; sum2 += smoothed[i] * smoothed[i]; }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(1e-9, sum2 / n - mean * mean));
  const thresh = mean + 0.7 * std;

  // Peak pick: local max, above threshold, ≥ MIN_PEAK_DIST samples since
  // last peak. We don't enforce MAX_PEAK_DIST during pick — that's used
  // to filter the final RR set.
  const peaks: number[] = [];
  let lastPeak = -MIN_PEAK_DIST;
  for (let i = 2; i < n - 2; i++) {
    const v = smoothed[i];
    if (v < thresh) continue;
    if (i - lastPeak < MIN_PEAK_DIST) continue;
    if (v <= smoothed[i - 1] || v < smoothed[i + 1]) continue;
    if (v < smoothed[i - 2] || v < smoothed[i + 2]) continue;
    peaks.push(i);
    lastPeak = i;
  }

  if (peaks.length < 3) {
    return { bpm: null, peaks, filtered: smoothed, confidence: "low" };
  }

  // RR intervals in seconds. Filter out anything outside the BPM range.
  const rrs: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const dt = (peaks[i] - peaks[i - 1]) / LIVE_HZ;
    if (dt >= 60 / MAX_BPM && dt <= 60 / MIN_BPM) rrs.push(dt);
  }
  if (rrs.length < 2) {
    return { bpm: null, peaks, filtered: smoothed, confidence: "low" };
  }
  const meanRr = rrs.reduce((a, b) => a + b, 0) / rrs.length;
  const bpm = 60 / meanRr;

  // Confidence: based on RR-interval coefficient of variation. Low CV =
  // regular pulse = trustworthy. High CV = artefact-dominated.
  let rrSum2 = 0;
  for (const r of rrs) rrSum2 += (r - meanRr) * (r - meanRr);
  const rrStd = Math.sqrt(rrSum2 / rrs.length);
  const cv = rrStd / meanRr;
  const confidence: Estimate["confidence"] =
    cv < 0.08 ? "good" : cv < 0.18 ? "ok" : "low";

  return { bpm, peaks, filtered: smoothed, confidence };
}

export function HeartRate({ liveBuf, tick: _tick }: Props) {
  const est = useMemo(() => {
    const buf = liveBuf.current;
    const primary = buf.ch[CH_PRIMARY] ?? [];
    let series = primary;
    let chUsed = CH_PRIMARY;
    if (primary.length < LIVE_HZ * 4) {
      const sec = buf.ch[CH_SECONDARY] ?? [];
      if (sec.length > primary.length) { series = sec; chUsed = CH_SECONDARY; }
    }
    const e = estimateBpm(series);
    return { ...e, chUsed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_tick]);

  return (
    <div className="hr-widget">
      <div className="hr-head">
        <div className="hr-label">Heart rate (推定)</div>
        <div className={`hr-conf hr-conf-${est.confidence}`}>{est.confidence}</div>
      </div>
      <div className="hr-body">
        <div className="hr-value">
          {est.bpm !== null ? (
            <>
              <strong>{Math.round(est.bpm)}</strong>
              <span>bpm</span>
            </>
          ) : (
            <small>蓄積中…</small>
          )}
        </div>
        <HrSparkline filtered={est.filtered} peaks={est.peaks} />
      </div>
      <small className="hr-caveat">
        ch{est.chUsed} (frontal) の BCG アーティファクト由来 · 参考値 (ECG/PPG 非搭載)
      </small>
    </div>
  );
}

function HrSparkline({ filtered, peaks }:
                       { filtered: Float32Array; peaks: number[] }) {
  const W = 360;
  const H = 56;
  if (filtered.length < 2) return <div className="hr-spark hr-spark-empty" />;

  // Show only the tail so the trace doesn't visually compress when the
  // window grows beyond ~6 s.
  const tailN = Math.min(filtered.length, Math.floor(LIVE_HZ * 6));
  const start = filtered.length - tailN;
  let mn = Infinity, mx = -Infinity;
  for (let i = start; i < filtered.length; i++) {
    if (filtered[i] < mn) mn = filtered[i];
    if (filtered[i] > mx) mx = filtered[i];
  }
  const span = Math.max(1e-6, mx - mn);
  const xOf = (i: number) => ((i - start) / (tailN - 1)) * W;
  const yOf = (v: number) => H - ((v - mn) / span) * (H - 4) - 2;

  let d = "";
  for (let i = start; i < filtered.length; i++) {
    const x = xOf(i).toFixed(1);
    const y = yOf(filtered[i]).toFixed(1);
    d += (i === start ? "M" : "L") + x + "," + y;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="hr-spark">
      <path d={d} fill="none" stroke="var(--bad)" strokeWidth="1.2" />
      {peaks
        .filter((p) => p >= start)
        .map((p) => (
          <circle key={p} cx={xOf(p)} cy={yOf(filtered[p])} r={2.2}
                  fill="var(--bad)" />
        ))}
    </svg>
  );
}

