import { useState } from "react";

import { BrainSvg } from "../components/BrainSvg";
import { MONTAGE, REGION_COLORS } from "../montage";
import { AppState, BAND_NAMES, BandName } from "../types";

export interface BrainTabProps {
  state: AppState;
}

export function Brain({ state }: BrainTabProps) {
  const [band, setBand] = useState<BandName>("alpha");
  const values = state.bandsNow[band];

  return (
    <div className="brain-wrap">
      <div className="panel">
        <div className="panel-head">
          <h2>Brain topography</h2>
          <label className="small-label">band:
            <select value={band} onChange={(e) => setBand(e.target.value as BandName)}>
              {BAND_NAMES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
        </div>
        <BrainSvg values={values} selected={state.threshold.channels} />
        <div className="brain-meta">
          <small>color = current {band} band power (auto-scaled to current max). Decision channels highlighted.</small>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Channel → 10-20 mapping</h2></div>
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
                <td>{(values[e.ch] ?? 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
