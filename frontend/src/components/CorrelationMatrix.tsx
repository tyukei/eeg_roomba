import { NCH } from "../types";

interface Props {
  matrix: number[][]; // NCH x NCH, values in [-1, 1]
  selected?: number[];
}

const CELL = 28;
const PAD_LEFT = 32;
const PAD_TOP = 32;
const SIZE = PAD_LEFT + CELL * NCH;

// Muted diverging: blue accent (+r) ↔ amber (-r), both desaturated.
function colorOf(r: number): string {
  const t = Math.max(-1, Math.min(1, r));
  if (t >= 0) {
    return `hsl(212 42% ${22 + t * 38}%)`;
  } else {
    return `hsl(28 38% ${22 + -t * 32}%)`;
  }
}

export function CorrelationMatrix({ matrix, selected }: Props) {
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ maxWidth: 560, display: "block" }}>
      {/* axis labels */}
      {Array.from({ length: NCH }, (_, i) => (
        <text key={`yl${i}`} x={PAD_LEFT - 6} y={PAD_TOP + i * CELL + CELL / 2 + 4}
              fontSize={10} textAnchor="end" fill={selected?.includes(i) ? "var(--accent)" : "var(--muted)"}>
          ch{i}
        </text>
      ))}
      {Array.from({ length: NCH }, (_, j) => (
        <text key={`xl${j}`} x={PAD_LEFT + j * CELL + CELL / 2} y={PAD_TOP - 8}
              fontSize={10} textAnchor="middle" fill={selected?.includes(j) ? "var(--accent)" : "var(--muted)"}>
          {j}
        </text>
      ))}
      {/* cells */}
      {matrix.map((row, i) =>
        row.map((v, j) => (
          <g key={`${i}-${j}`}>
            <rect x={PAD_LEFT + j * CELL} y={PAD_TOP + i * CELL} width={CELL - 1} height={CELL - 1}
                  fill={colorOf(v)} />
            <text x={PAD_LEFT + j * CELL + CELL / 2} y={PAD_TOP + i * CELL + CELL / 2 + 3}
                  textAnchor="middle" fontSize={8.5} fill={Math.abs(v) > 0.5 ? "var(--text)" : "var(--muted)"}>
              {v.toFixed(2)}
            </text>
          </g>
        ))
      )}
    </svg>
  );
}
