import { NCH } from "../types";

interface Props {
  matrix: number[][]; // NCH x NCH, values in [-1, 1]
  selected?: number[];
}

const CELL = 28;
const PAD_LEFT = 32;
const PAD_TOP = 32;
const SIZE = PAD_LEFT + CELL * NCH;

// Diverging palette: -1 (blue) → 0 (dark) → +1 (red).
function colorOf(r: number): string {
  const t = Math.max(-1, Math.min(1, r));
  if (t >= 0) {
    const k = Math.round(t * 220);
    return `rgb(${30 + k},${30 + Math.round(k * 0.2)},${50})`;
  } else {
    const k = Math.round(-t * 220);
    return `rgb(${30},${30 + Math.round(k * 0.4)},${50 + k})`;
  }
}

export function CorrelationMatrix({ matrix, selected }: Props) {
  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ maxWidth: 560, display: "block" }}>
      {/* axis labels */}
      {Array.from({ length: NCH }, (_, i) => (
        <text key={`yl${i}`} x={PAD_LEFT - 6} y={PAD_TOP + i * CELL + CELL / 2 + 4}
              fontSize={10} textAnchor="end" fill={selected?.includes(i) ? "#fff" : "#9aa3b2"}>
          ch{i}
        </text>
      ))}
      {Array.from({ length: NCH }, (_, j) => (
        <text key={`xl${j}`} x={PAD_LEFT + j * CELL + CELL / 2} y={PAD_TOP - 8}
              fontSize={10} textAnchor="middle" fill={selected?.includes(j) ? "#fff" : "#9aa3b2"}>
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
                  textAnchor="middle" fontSize={8.5} fill={Math.abs(v) > 0.5 ? "#fff" : "#9aa3b2"}>
              {v.toFixed(2)}
            </text>
          </g>
        ))
      )}
    </svg>
  );
}
