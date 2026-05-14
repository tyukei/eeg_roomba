// uPlot draws onto canvas, which cannot resolve CSS custom properties.
// Read the values once and hand them in as concrete hex/rgba strings.

let cache: Record<string, string> | null = null;

function readVars(): Record<string, string> {
  const s = getComputedStyle(document.documentElement);
  return {
    muted:    s.getPropertyValue("--muted").trim()   || "#7a8392",
    border:   s.getPropertyValue("--border").trim()  || "#353a45",
    text:     s.getPropertyValue("--text").trim()    || "#e6e8ee",
    accent:   s.getPropertyValue("--accent").trim()  || "#7aa2f7",
    surface2: s.getPropertyValue("--surface-2").trim() || "#2b303a",
  };
}

export function themeColors() {
  if (!cache) cache = readVars();
  return cache;
}
