import { useMemo } from "react";
import { AppState, BandName, NCH } from "../types";

interface Props {
  state: AppState;
  bandsBuf: React.MutableRefObject<{
    ts: number[];
    bands: Record<BandName, number[][]>;
  }>;
  tick: number; // 200ms force-render counter
}

const EPS = 1e-6;
const SMOOTH_N = 3;

// β / (α + θ) — Pope の engagement index。集中時に上がる。
function focusOf(a: number, b: number, t: number): number {
  return b / (a + t + EPS);
}
// α / (α + β) — α dominance。リラックス時に上がる。0..1。
function relaxOf(a: number, b: number): number {
  return a / (a + b + EPS);
}

function meanCh(arr: number[]): number {
  let s = 0;
  let n = 0;
  for (const v of arr) {
    if (Number.isFinite(v)) { s += v; n++; }
  }
  return n ? s / n : 0;
}

// 末尾 N サンプルの単純移動平均で値のフリッカを抑える。
function trailingMean(xs: number[], n: number): number {
  if (xs.length === 0) return 0;
  const k = Math.min(n, xs.length);
  let s = 0;
  for (let i = xs.length - k; i < xs.length; i++) s += xs[i];
  return s / k;
}

export function MindState({ state, bandsBuf, tick: _tick }: Props) {
  const buf = bandsBuf.current;

  // Per-sample 16ch平均 → focus/relax 時系列。
  const series = useMemo(() => {
    const n = buf.ts.length;
    const out: { ts: number; focus: number; relax: number }[] = [];
    for (let i = 0; i < n; i++) {
      let aSum = 0, bSum = 0, tSum = 0, cnt = 0;
      for (let c = 0; c < NCH; c++) {
        const va = buf.bands.alpha[c][i];
        const vb = buf.bands.beta[c][i];
        const vt = buf.bands.theta[c][i];
        if (Number.isFinite(va) && Number.isFinite(vb) && Number.isFinite(vt)) {
          aSum += va; bSum += vb; tSum += vt; cnt++;
        }
      }
      if (cnt === 0) continue;
      const a = aSum / cnt, b = bSum / cnt, t = tSum / cnt;
      out.push({ ts: buf.ts[i], focus: focusOf(a, b, t), relax: relaxOf(a, b) });
    }
    return out;
    // tick で再描画させたいので tick も deps に
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_tick]);

  const focusNow = trailingMean(series.map((s) => s.focus), SMOOTH_N);
  const relaxNow = trailingMean(series.map((s) => s.relax), SMOOTH_N);

  // Series が空のとき用フォールバック（起動直後の数秒）
  const aNow = meanCh(state.bandsNow.alpha);
  const bNow = meanCh(state.bandsNow.beta);
  const tNow = meanCh(state.bandsNow.theta);
  const focusDisp = series.length ? focusNow : focusOf(aNow, bNow, tNow);
  const relaxDisp = series.length ? relaxNow : relaxOf(aNow, bNow);

  // 状態判定はゲージと同じ smoothed series から導出する — bandsNow を直接
  // 使うとフレーム単位でフリッカしバッジとゲージが食い違って見える。
  // composite = (focus - 2*relax) / (focus + 2*relax + ε) ∈ [-1, +1]、
  //   focus は 0..2 想定なので relax(0..1) と等価に並べるために x2 する。
  const cf = focusDisp;
  const cr = relaxDisp * 2;
  const composite = cf + cr > EPS ? (cf - cr) / (cf + cr) : 0;
  const status: "focused" | "relaxed" | "neutral" =
    composite > 0.15 ? "focused"
    : composite < -0.15 ? "relaxed"
    : "neutral";
  const statusLabel = status === "focused" ? "集中"
                    : status === "relaxed" ? "リラックス"
                    : "中立";
  const statusHint = status === "focused" ? "β > α: 認知活動が高い状態"
                   : status === "relaxed" ? "α > β: リラックス・α 優位"
                   : "α と β がほぼ拮抗";

  // β/(α+θ) は実測で 0..2 強の幅があるので 2.0 をフルスケールとして正規化。
  const focusPct = Math.max(0, Math.min(100, (focusDisp / 2) * 100));
  const relaxPct = Math.max(0, Math.min(100, relaxDisp * 100));

  return (
    <div className={`mind-panel mind-${status}`}>
      <div className="mind-head">
        <div className="mind-status-badge">
          <span className="mind-status-label">{statusLabel}</span>
          <span className="mind-status-hint">{statusHint}</span>
        </div>
        <div className="mind-gauges">
          <Gauge label="Focus" sub="β / (α+θ)" pct={focusPct} raw={focusDisp} max={2} color="var(--warn)" />
          <Gauge label="Relax" sub="α / (α+β)" pct={relaxPct} raw={relaxDisp} max={1} color="var(--accent)" />
        </div>
      </div>
      <MindTimeline series={series} />
    </div>
  );
}

function Gauge({ label, sub, pct, raw, max, color }:
                { label: string; sub: string; pct: number; raw: number; max: number; color: string }) {
  return (
    <div className="mind-gauge">
      <div className="mind-gauge-head">
        <strong>{label}</strong>
        <small>{sub}</small>
      </div>
      <div className="mind-gauge-bar">
        <div className="mind-gauge-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="mind-gauge-num" style={{ color }}>
        {raw.toFixed(2)}
        <span className="mind-gauge-max"> / {max.toFixed(1)}</span>
      </div>
    </div>
  );
}

function MindTimeline({ series }: { series: { ts: number; focus: number; relax: number }[] }) {
  const W = 800;
  const H = 120;
  const padL = 28, padR = 8, padT = 8, padB = 18;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  if (series.length < 2) {
    return (
      <div className="mind-timeline-empty">
        <small>時系列を蓄積中… (60秒分)</small>
      </div>
    );
  }

  const t0 = series[0].ts;
  const t1 = series[series.length - 1].ts;
  const dt = Math.max(1, t1 - t0);

  // Focus は 0..2 を、Relax は 0..1 をそれぞれ別軸で同じパネルに描く。
  // 軸の混在を避けるため両方とも 0..1 に正規化して描き、左軸ラベルで
  // Focus 2.0 / Relax 1.0 の上限を示す。
  const focusNorm = (v: number) => Math.max(0, Math.min(1, v / 2));
  const relaxNorm = (v: number) => Math.max(0, Math.min(1, v));

  const xOf = (ts: number) => padL + ((ts - t0) / dt) * innerW;
  const yOf = (norm: number) => padT + (1 - norm) * innerH;

  const pathOf = (pick: (s: { focus: number; relax: number }) => number) => {
    let d = "";
    for (let i = 0; i < series.length; i++) {
      const x = xOf(series[i].ts);
      const y = yOf(pick(series[i]));
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    }
    return d;
  };

  const focusPath = pathOf((s) => focusNorm(s.focus));
  const relaxPath = pathOf((s) => relaxNorm(s.relax));

  const secsSpan = Math.round(dt);

  return (
    <div className="mind-timeline">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mind-timeline-svg">
        {/* baseline + half-grid */}
        <line x1={padL} y1={padT + innerH * 0.5} x2={W - padR} y2={padT + innerH * 0.5}
              stroke="var(--border)" strokeDasharray="3 3" />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="var(--border)" />
        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="var(--border)" />

        {/* Relax (alpha) — drawn first so Focus sits on top */}
        <path d={relaxPath} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
        {/* Focus */}
        <path d={focusPath} fill="none" stroke="var(--warn)" strokeWidth="1.6" />

        {/* Y axis label hints */}
        <text x={padL - 4} y={padT + 8} fontSize="9" fill="var(--muted)" textAnchor="end">hi</text>
        <text x={padL - 4} y={H - padB} fontSize="9" fill="var(--muted)" textAnchor="end">lo</text>

        {/* X axis */}
        <text x={padL} y={H - 4} fontSize="9" fill="var(--muted)" textAnchor="start">
          -{secsSpan}s
        </text>
        <text x={W - padR} y={H - 4} fontSize="9" fill="var(--muted)" textAnchor="end">
          now
        </text>
      </svg>
      <div className="mind-timeline-legend">
        <span className="mind-legend-item">
          <span className="mind-legend-swatch" style={{ background: "var(--warn)" }} />
          Focus
        </span>
        <span className="mind-legend-item">
          <span className="mind-legend-swatch" style={{ background: "var(--accent)" }} />
          Relax
        </span>
        <small className="mind-legend-meta">16ch平均 · {series.length} samples / {secsSpan}s</small>
      </div>
    </div>
  );
}
