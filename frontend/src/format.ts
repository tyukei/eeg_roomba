// Band-power values are in μV²-derived units that routinely run into the
// hundreds of millions, which doesn't fit in a small bar label and is
// hard to compare at a glance. Format with an SI prefix and 3 sig figs.

const PREFIXES: { v: number; s: string }[] = [
  { v: 1e12, s: "T" },
  { v: 1e9,  s: "G" },
  { v: 1e6,  s: "M" },
  { v: 1e3,  s: "k" },
  { v: 1,    s: ""  },
  { v: 1e-3, s: "m" },
  { v: 1e-6, s: "µ" },
];

export function formatSI(x: number, digits = 3): string {
  if (!isFinite(x)) return "—";
  if (x === 0) return "0";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  const p = PREFIXES.find((p) => a >= p.v) ?? PREFIXES[PREFIXES.length - 1];
  const v = a / p.v;
  // 3 sig figs: 123 → "123", 12.3 → "12.3", 1.23 → "1.23"
  const fixed = v >= 100 ? v.toFixed(Math.max(0, digits - 3))
              : v >= 10  ? v.toFixed(Math.max(0, digits - 2))
              :            v.toFixed(Math.max(0, digits - 1));
  return `${sign}${fixed}${p.s}`;
}
