import { useMemo } from "react";

import { viridis } from "../colormap";
import { MONTAGE } from "../montage";
import { BandName, NCH } from "../types";

interface Props {
  /** Time-aligned band history (mutated in place by App.tsx). */
  bandsBuf: React.MutableRefObject<{
    ts: number[];
    bands: Record<BandName, number[][]>;
  }>;
  band: BandName;
  tick: number;            // parent ticks every 200ms — re-render trigger
  hovered: number | null;
  onHover: (ch: number | null) => void;
}

const TARGET_COLS = 120;   // cap horizontal resolution for cheap render
const ROW_HEIGHT = 16;     // px per channel row
const ROW_GAP = 0;         // 0 → reads as a contiguous spectrogram image

/**
 * Time × channels heatmap for one band.
 *
 * Rows = 16 channels (top→bottom). Columns = sampled time slices, newest on
 * the right. Cells are coloured by the band power at that (ch, t). Normalised
 * across the entire visible window (not per-channel) so a synchronously
 * spiking electrode group reads as a vertical bright stripe.
 *
 * Useful for spotting events: a sudden α-burst across occipital channels
 * shows up as a bright cluster on the bottom rows for a few columns.
 */
export function TimeChannelHeatmap({ bandsBuf, band, tick, hovered, onHover }: Props) {
  const cells = useMemo(() => {
    const buf = bandsBuf.current;
    const n = buf.ts.length;
    if (n < 2) return null;
    const step = Math.max(1, Math.floor(n / TARGET_COLS));
    const cols = Math.floor(n / step);
    // Build a 2D array [ch][col] of band values.
    const grid: number[][] = Array.from({ length: NCH }, () => Array(cols).fill(0));
    let gmax = 1e-9;
    for (let c = 0; c < NCH; c++) {
      const series = buf.bands[band][c];
      for (let j = 0; j < cols; j++) {
        const i = j * step;
        const v = series[i] ?? 0;
        grid[c][j] = v;
        if (v > gmax) gmax = v;
      }
    }
    return { grid, cols, gmax };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, band]);

  if (!cells) {
    return <div className="tch-empty">waiting for samples…</div>;
  }

  return (
    <div className="tch-wrap">
      <div className="tch-axis">
        {Array.from({ length: NCH }, (_, ch) => (
          <div
            key={ch}
            className={`tch-row-label ${hovered === ch ? "hovered" : ""}`}
            style={{ height: ROW_HEIGHT, marginBottom: ROW_GAP }}
            onPointerEnter={() => onHover(ch)}
            onPointerLeave={() => onHover(null)}
          >
            <strong>ch{ch}</strong>
            <small>{MONTAGE[ch]?.name}</small>
          </div>
        ))}
      </div>
      <div className="tch-grid">
        {Array.from({ length: NCH }, (_, ch) => (
          <div
            key={ch}
            className={`tch-row ${hovered === ch ? "hovered" : ""}`}
            style={{ height: ROW_HEIGHT, marginBottom: ROW_GAP }}
            onPointerEnter={() => onHover(ch)}
            onPointerLeave={() => onHover(null)}
          >
            {cells.grid[ch].map((v, j) => (
              <div
                key={j}
                className="tch-cell"
                style={{
                  background: viridis(v / cells.gmax),
                  flex: `0 0 ${100 / cells.cols}%`,
                }}
              />
            ))}
          </div>
        ))}
        <div className="tch-time-legend">
          <small>← older   |   newer →</small>
        </div>
      </div>
    </div>
  );
}
