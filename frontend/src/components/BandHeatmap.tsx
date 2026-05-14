import { Fragment } from "react";

import { viridis } from "../colormap";
import { MONTAGE } from "../montage";
import { AppState, BAND_NAMES, BandName, NCH } from "../types";

interface Props {
  state: AppState;
  hovered: number | null;
  onHover: (ch: number | null) => void;
}

/**
 * 16-channel × 5-band heatmap.
 *
 * Each row is a channel, each column a band. Cells are normalised
 * **per band** so the user sees which channels lead within each band
 * rather than which band dominates overall (which would always be δ).
 */
export function BandHeatmap({ state, hovered, onHover }: Props) {
  // Per-band max so the colour scale is comparable across channels for the
  // same band. Avoids the "δ swamps everything" problem you'd get with a
  // single global max.
  const perBandMax = {} as Record<BandName, number>;
  let globalMax = 0;
  for (const b of BAND_NAMES) {
    let m = 0;
    const arr = state.bandsNow[b];
    for (let c = 0; c < NCH; c++) if (arr[c] > m) m = arr[c];
    perBandMax[b] = Math.max(1e-9, m);
    if (m > globalMax) globalMax = m;
  }

  if (globalMax === 0) {
    return <div className="bh-empty">waiting for samples…</div>;
  }

  return (
    <div className="bh-wrap">
      <div className="bh-grid">
        <div className="bh-corner" />
        {BAND_NAMES.map((b) => (
          <div key={b} className="bh-colhead">{b}</div>
        ))}
        {Array.from({ length: NCH }, (_, ch) => {
          const isHover = hovered === ch;
          return (
            <Fragment key={ch}>
              <div
                className={`bh-rowhead ${isHover ? "hovered" : ""}`}
                onPointerEnter={() => onHover(ch)}
                onPointerLeave={() => onHover(null)}
              >
                <strong>ch{ch}</strong>
                <small>{MONTAGE[ch]?.name}</small>
              </div>
              {BAND_NAMES.map((b) => {
                const v = state.bandsNow[b][ch] ?? 0;
                const norm = v / perBandMax[b];
                return (
                  <div
                    key={`${ch}-${b}`}
                    className={`bh-cell ${isHover ? "hovered" : ""}`}
                    style={{ background: viridis(norm) }}
                    title={`ch${ch} ${b}: ${v.toFixed(2)}`}
                    onPointerEnter={() => onHover(ch)}
                    onPointerLeave={() => onHover(null)}
                  />
                );
              })}
            </Fragment>
          );
        })}
      </div>
      <div className="bh-legend">
        <small>normalised within each band ·</small>
        <span className="bh-legend-bar" />
        <small>low → high</small>
      </div>
    </div>
  );
}
