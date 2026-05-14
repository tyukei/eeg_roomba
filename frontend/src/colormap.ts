// Shared continuous colormap. Approximates viridis with 5 RGB stops,
// linearly interpolated — perceptually uniform-ish and reads well on the
// dark surface. Used by every heatmap so the dashboard stays coherent.
const STOPS: [number, number, number][] = [
  [68, 1, 84],     // 0.00 — deep purple
  [59, 82, 139],   // 0.25 — blue
  [33, 144, 141],  // 0.50 — teal
  [94, 201, 98],   // 0.75 — green
  [253, 231, 37],  // 1.00 — yellow
];

export function viridis(norm: number): string {
  const v = Math.max(0, Math.min(1, norm));
  const seg = v * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(seg));
  const t = seg - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bb = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bb})`;
}

// CSS gradient string for legends / accents.
export const VIRIDIS_GRADIENT =
  "linear-gradient(to right, " +
  STOPS.map((s, i) => `rgb(${s[0]}, ${s[1]}, ${s[2]}) ${(i / (STOPS.length - 1)) * 100}%`).join(", ") +
  ")";
