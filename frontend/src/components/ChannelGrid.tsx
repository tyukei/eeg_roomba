import { useMemo } from "react";

import { NCH } from "../types";

interface Props {
  liveBuf: React.MutableRefObject<{ ts: number[]; ch: number[][] }>;
  selected?: number[];
  tick: number;     // re-render trigger (parent ticks at 200ms)
}

/**
 * 16-channel EEG live view: one tiny sparkline per channel in a 4x4 grid.
 * Each cell autoscales independently so a high-amplitude channel doesn't
 * flatten the others. Selected (decision) channels are highlighted.
 */
export function ChannelGrid({ liveBuf, selected = [], tick }: Props) {
  const buf = liveBuf.current;
  const selSet = useMemo(() => new Set(selected), [selected]);

  return (
    <div className="ch-grid">
      {Array.from({ length: NCH }, (_, i) => {
        const data = buf.ch[i];
        const isSelected = selSet.has(i);
        const last = data.length ? data[data.length - 1] : null;
        return (
          <div key={i} className={`ch-cell ${isSelected ? "selected" : ""}`}>
            <div className="ch-cell-head">
              <span className="ch-cell-name">ch{i}</span>
              <span className="ch-cell-now">{last == null ? "—" : last.toFixed(0)}</span>
            </div>
            <Sparkline data={data} highlighted={isSelected} tick={tick} />
          </div>
        );
      })}
    </div>
  );
}

const VBW = 200, VBH = 44;

function Sparkline({ data, highlighted, tick }: { data: number[]; highlighted: boolean; tick: number }) {
  const path = useMemo(() => {
    const n = data.length;
    if (n < 2) return "";
    // Decimate the buffer so SVG stays light (LIVE_HZ=50 × 10s = 500 points).
    const step = Math.max(1, Math.floor(n / 160));
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i += step) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) return "";
    const range = Math.max(1e-9, max - min);
    let p = "";
    let first = true;
    for (let i = 0; i < n; i += step) {
      const x = (i / (n - 1)) * VBW;
      const y = VBH - ((data[i] - min) / range) * VBH;
      p += (first ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
      first = false;
    }
    return p;
    // tick drives re-evaluation since `data` is mutated in place by the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  return (
    <svg viewBox={`0 0 ${VBW} ${VBH}`} width="100%" height={VBH}
         preserveAspectRatio="none" className="ch-spark">
      <path d={path} fill="none"
            stroke={highlighted ? "var(--accent)" : "var(--muted)"}
            strokeWidth={highlighted ? 1.3 : 1} />
    </svg>
  );
}
