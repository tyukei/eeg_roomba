import { Fragment } from "react";

import { MONTAGE } from "../montage";
import { AppState, BAND_NAMES, BandName, NCH } from "../types";

interface Props {
  state: AppState;
  hovered: number | null;
  onHover: (ch: number | null) => void;
}

/** Smooth blue→amber ramp (low → high power). HSL keeps it monochrome-ish
 *  so it doesn't clash with the rest of the dashboard's palette. */
function colorFor(norm: number): string {
  const v = Math.max(0, Math.min(1, norm));
  // Hue: 212 (dark blue) → 25 (amber). Saturation rises with intensity.
  const hue = 212 - 187 * v;
  const sat = 25 + 50 * v;
  const light = 30 + 30 * v;
  return `hsl(${hue} ${sat}% ${light}%)`;
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
  const perBandMax: Record<BandName, number> = {} as any;
  for (const b of BAND_NAMES) {
    let m = 0;
    const arr = state.bandsNow[b];
    for (let c = 0; c < NCH; c++) if (arr[c] > m) m = arr[c];
    perBandMax[b] = Math.max(1e-9, m);
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
                    style={{ background: colorFor(norm) }}
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
