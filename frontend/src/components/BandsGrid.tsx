import { formatSI } from "../format";
import { MONTAGE } from "../montage";
import { AppState, BAND_COLORS, BAND_NAMES, BandName, NCH } from "../types";

interface Props {
  state: AppState;
  selected?: number[];
  hovered?: number | null;
  onHover?: (ch: number | null) => void;
}

/**
 * 16-channel × 5-band dashboard. Each channel gets its own card with five
 * mini-bars (δ θ α β γ) so the user can see the band distribution shape
 * per electrode at a glance. Each card normalises to its own max so one
 * dominant channel doesn't flatten the rest.
 */
export function BandsGrid({ state, selected = [], hovered, onHover }: Props) {
  const selSet = new Set(selected);
  return (
    <div className="bands-grid">
      {Array.from({ length: NCH }, (_, ch) => {
        const values: { band: BandName; v: number }[] = BAND_NAMES.map((b) => ({
          band: b, v: state.bandsNow[b][ch] ?? 0,
        }));
        const max = Math.max(1, ...values.map((x) => x.v));
        const isSel = selSet.has(ch);
        const isHovered = hovered === ch;
        const label = MONTAGE[ch]?.name ?? "";
        return (
          <div
            key={ch}
            className={`bg-cell ${isSel ? "selected" : ""} ${isHovered ? "hovered" : ""}`}
            onPointerEnter={() => onHover?.(ch)}
            onPointerLeave={() => onHover?.(null)}
          >
            <div className="bg-cell-head">
              <span className="bg-cell-ch">ch{ch}</span>
              <span className="bg-cell-electrode">{label}</span>
            </div>
            <div className="bg-cell-bars">
              {values.map(({ band, v }) => (
                <div key={band} className="bg-bar" title={`${band}: ${formatSI(v)}`}>
                  <div className="bg-bar-fill"
                       style={{ height: `${(v / max) * 100}%`, background: BAND_COLORS[band] }} />
                  <span className="bg-bar-label">{band[0]}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
