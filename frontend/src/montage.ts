/**
 * PiEEG-16 channel → 10-20 system electrode position mapping.
 *
 * Positions are in a unit circle centered at (0,0) — radius 1 = head edge.
 * Convention: +x = right ear, +y = nose (top of head), -y = inion (back).
 *
 * The actual channel-to-electrode wiring depends on the PiEEG-16 board layout
 * and the user's cap. We default to a sensible "frontal+central+parietal+
 * occipital" 16-ch montage covering both hemispheres. Override via VITE if
 * the lab uses a different placement.
 */

export interface Electrode {
  ch: number;
  name: string;    // 10-20 label
  x: number;       // -1..+1 (right positive)
  y: number;       // -1..+1 (front positive)
  region: "frontal" | "central" | "parietal" | "occipital" | "temporal";
}

// 10-20 canonical positions (approximate).
const POS = {
  Fp1: [-0.27, 0.95], Fp2: [0.27, 0.95],
  F7: [-0.80, 0.59],  F3: [-0.40, 0.55], Fz: [0, 0.55], F4: [0.40, 0.55], F8: [0.80, 0.59],
  T7: [-1.00, 0.00],  C3: [-0.50, 0.00], Cz: [0, 0],     C4: [0.50, 0.00], T8: [1.00, 0.00],
  P7: [-0.80, -0.59], P3: [-0.40, -0.55], Pz: [0, -0.55], P4: [0.40, -0.55], P8: [0.80, -0.59],
  O1: [-0.27, -0.95], O2: [0.27, -0.95],
} as const;

const REGION: Record<string, Electrode["region"]> = {
  Fp1: "frontal", Fp2: "frontal", F7: "frontal", F3: "frontal", Fz: "frontal", F4: "frontal", F8: "frontal",
  T7: "temporal", T8: "temporal", P7: "temporal", P8: "temporal",
  C3: "central", Cz: "central", C4: "central",
  P3: "parietal", Pz: "parietal", P4: "parietal",
  O1: "occipital", O2: "occipital",
};

// Default 16-ch mapping. Chip A (ch0-7) → frontal/central. Chip B (ch8-15) → temporal/parietal/occipital.
const DEFAULT_LABELS: string[] = [
  "Fp1", "Fp2", "F3", "F4", "C3", "C4", "O1", "O2",          // chip A
  "F7", "F8", "T7", "T8", "P7", "P8", "P3", "P4",            // chip B
];

export const MONTAGE: Electrode[] = DEFAULT_LABELS.map((name, ch) => {
  const [x, y] = POS[name as keyof typeof POS];
  return { ch, name, x, y, region: REGION[name] };
});

// Monochrome — anterior (front) darker, posterior lighter. Hue tied to brand accent.
export const REGION_COLORS: Record<Electrode["region"], string> = {
  frontal:   "hsl(212 22% 35%)",
  central:   "hsl(212 22% 45%)",
  temporal:  "hsl(212 16% 40%)",
  parietal:  "hsl(212 22% 55%)",
  occipital: "hsl(212 22% 65%)",
};
