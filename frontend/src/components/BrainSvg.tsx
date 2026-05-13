import { MONTAGE, REGION_COLORS } from "../montage";

interface Props {
  values?: number[];  // per-channel value (0..1 normalized)
  selected?: number[]; // highlight specific channels
  onClick?: (ch: number) => void;
}

const SIZE = 280;
const R = SIZE / 2 - 12;
const CX = SIZE / 2;
const CY = SIZE / 2;

function colorOf(v: number | undefined): string {
  if (v === undefined || v <= 0) return "hsl(212 12% 22%)";
  const t = Math.max(0, Math.min(1, v));
  return `hsl(212 ${20 + t * 50}% ${28 + t * 42}%)`;
}

export function BrainSvg({ values, selected, onClick }: Props) {
  // Auto-normalize values to 0..1 against max.
  const max = values ? Math.max(1e-6, ...values) : 1;

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ maxWidth: 320, display: "block", margin: "0 auto" }}>
      {/* Head outline */}
      <circle cx={CX} cy={CY} r={R} fill="var(--surface-2)" stroke="var(--border)" strokeWidth={1.5} />
      <polygon
        points={`${CX - 12},${CY - R + 2} ${CX + 12},${CY - R + 2} ${CX},${CY - R - 14}`}
        fill="var(--surface-2)" stroke="var(--border)" strokeWidth={1.5}
      />
      <ellipse cx={CX - R} cy={CY} rx={6} ry={14} fill="var(--surface-2)" stroke="var(--border)" strokeWidth={1.5} />
      <ellipse cx={CX + R} cy={CY} rx={6} ry={14} fill="var(--surface-2)" stroke="var(--border)" strokeWidth={1.5} />
      <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="var(--border)" strokeWidth={1} strokeDasharray="2 4" />
      <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="var(--border)" strokeWidth={1} strokeDasharray="2 4" />

      {/* Electrodes */}
      {MONTAGE.map((e) => {
        const x = CX + e.x * R * 0.85;
        const y = CY - e.y * R * 0.85;
        const v = values ? values[e.ch] / max : undefined;
        const fill = values ? colorOf(v) : REGION_COLORS[e.region];
        const isSel = selected?.includes(e.ch);
        return (
          <g key={e.ch} style={{ cursor: onClick ? "pointer" : "default" }} onClick={() => onClick?.(e.ch)}>
            <circle
              cx={x} cy={y}
              r={isSel ? 15 : 13}
              fill={fill}
              stroke={isSel ? "var(--accent)" : "var(--bg)"}
              strokeWidth={isSel ? 2 : 1.5}
            />
            <text x={x} y={y + 3} textAnchor="middle" fontSize={9.5} fill="var(--text)" fontWeight={500}>
              {e.name}
            </text>
            <text x={x} y={y + 24} textAnchor="middle" fontSize={9} fill="var(--muted)">
              ch{e.ch}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
