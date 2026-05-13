import { useMemo, useState } from "react";
import UplotReact from "uplot-react";
import uPlot from "uplot";

import { BAND_COLORS, BAND_NAMES, BandName, NCH } from "../types";

export interface BandsTabProps {
  bandsBuf: React.MutableRefObject<{
    ts: number[];
    bands: Record<BandName, number[][]>; // [band][ch][t]
  }>;
  tick: number;
}

export function Bands({ bandsBuf, tick }: BandsTabProps) {
  void tick;
  const [ch, setCh] = useState(6);
  const [scale, setScale] = useState<"linear" | "log">("log");

  const buf = bandsBuf.current;

  const data = useMemo<uPlot.AlignedData>(() => {
    if (buf.ts.length === 0) return [[], [], [], [], [], []] as any;
    return [
      buf.ts.slice(),
      ...BAND_NAMES.map((b) => buf.bands[b][ch].slice()),
    ] as any;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf.ts.length, buf.ts[buf.ts.length - 1], ch]);

  const opts = useMemo<uPlot.Options>(() => ({
    width: 900, height: 360,
    scales: { x: { time: true }, y: { auto: true, distr: scale === "log" ? 3 : 1 } },
    series: [
      {},
      ...BAND_NAMES.map((b) => ({
        label: b,
        stroke: BAND_COLORS[b],
        width: 1.5,
      })),
    ],
    axes: [{}, { size: 100 }],
    legend: { show: false },
  }), [scale]);

  return (
    <div className="bands-wrap">
      <div className="panel">
        <div className="panel-head">
          <h2>Band power · 60s</h2>
          <div className="row" style={{ gap: 8 }}>
            <label className="small-label">ch:
              <select value={ch} onChange={(e) => setCh(Number(e.target.value))}>
                {Array.from({ length: NCH }, (_, i) => (
                  <option key={i} value={i}>ch{i}</option>
                ))}
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
        <div className="chart"><UplotReact options={opts} data={data} /></div>
        <div className="band-legend">
          {BAND_NAMES.map((b) => (
            <span key={b} className="band-chip" style={{ borderColor: BAND_COLORS[b] }}>
              <span className="band-swatch" style={{ background: BAND_COLORS[b] }} />
              <strong>{b}</strong>
              <small>{({ delta: "1-4Hz", theta: "4-8Hz", alpha: "8-13Hz", beta: "13-30Hz", gamma: "30-45Hz" } as const)[b]}</small>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
