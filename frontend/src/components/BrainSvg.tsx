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
  if (v === undefined || v <= 0) return "#1e2533";
  // viridis-ish ramp
  const t = Math.max(0, Math.min(1, v));
  const r = Math.round(68 + (250 - 68) * t);
  const g = Math.round(1 + (228 - 1) * t);
  const b = Math.round(84 + (39 - 84) * t);
  return `rgb(${r},${g},${b})`;
}

export function BrainSvg({ values, selected, onClick }: Props) {
  // Auto-normalize values to 0..1 against max.
  const max = values ? Math.max(1e-6, ...values) : 1;

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ maxWidth: 320, display: "block", margin: "0 auto" }}>
      {/* Head outline */}
      <circle cx={CX} cy={CY} r={R} fill="#0f1115" stroke="#3b4252" strokeWidth={2} />
      {/* Nose */}
      <polygon
        points={`${CX - 12},${CY - R + 2} ${CX + 12},${CY - R + 2} ${CX},${CY - R - 14}`}
        fill="#0f1115" stroke="#3b4252" strokeWidth={2}
      />
      {/* Left ear */}
      <ellipse cx={CX - R} cy={CY} rx={6} ry={14} fill="#0f1115" stroke="#3b4252" strokeWidth={2} />
      {/* Right ear */}
      <ellipse cx={CX + R} cy={CY} rx={6} ry={14} fill="#0f1115" stroke="#3b4252" strokeWidth={2} />
      {/* Mid lines */}
      <line x1={CX} y1={CY - R} x2={CX} y2={CY + R} stroke="#2a2f38" strokeWidth={1} strokeDasharray="2 4" />
      <line x1={CX - R} y1={CY} x2={CX + R} y2={CY} stroke="#2a2f38" strokeWidth={1} strokeDasharray="2 4" />

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
              r={isSel ? 16 : 13}
              fill={fill}
              stroke={isSel ? "#fff" : "#0f1115"}
              strokeWidth={isSel ? 2.5 : 2}
            />
            <text x={x} y={y + 4} textAnchor="middle" fontSize={10} fill="#fff" fontWeight={600}>
              {e.name}
            </text>
            <text x={x} y={y + 24} textAnchor="middle" fontSize={9} fill="#9aa3b2">
              ch{e.ch}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
