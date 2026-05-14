import { useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";

interface Props {
  apiBase: string;
  /** Ref of the DOM node to screenshot — typically the pieeg tab root. */
  targetRef: React.RefObject<HTMLDivElement>;
}

type Status = "idle" | "capturing" | "analyzing" | "done" | "error";

/** Panel names Gemini is told it can cite. Keep in sync with the api-side
 *  ANALYZE_INSTRUCTION and the `data-panel` attributes on PiEEG.tsx. */
const KNOWN_PANELS = [
  "Per-channel bands",   // ordered longest-first so "Per-channel bands"
  "Channel correlation", // matches before "Bands"
  "Cognitive metrics",
  "Band power 60s",
  "Topography",
  "EEG live",
  "Bands",
  "PSD",
];

/** Pull the panel names off the `根拠: ...` line in Gemini's reply.
 *  Tolerates Japanese / English commas. */
function parseEvidence(text: string): string[] {
  const m = text.match(/根拠[：:]\s*(.+)/);
  if (!m) return [];
  const out = new Set<string>();
  for (const raw of m[1].split(/[,，、・]/)) {
    const t = raw.trim();
    if (!t) continue;
    const hit = KNOWN_PANELS.find((p) => t.toLowerCase().includes(p.toLowerCase()));
    if (hit) out.add(hit);
  }
  return Array.from(out);
}

async function captureEvidence(names: string[], bg: string): Promise<{ name: string; src: string }[]> {
  const out: { name: string; src: string }[] = [];
  for (const name of names) {
    const el = document.querySelector<HTMLElement>(`[data-panel="${name}"]`);
    if (!el) continue;
    try {
      const src = await toPng(el, { cacheBust: true, pixelRatio: 0.85, backgroundColor: bg });
      out.push({ name, src });
    } catch {
      /* skip one bad capture, keep the rest */
    }
  }
  return out;
}

export function AnalyzePanel({ apiBase, targetRef }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<string>("");
  const [evidence, setEvidence] = useState<{ name: string; src: string }[]>([]);
  const [err, setErr] = useState<string>("");
  const [cooldown, setCooldown] = useState(false);   // throttle window — button disabled
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!cooldown) return;
    const t = window.setTimeout(() => setCooldown(false), 1500);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  // Cleanup any pending fetch on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    if (status === "capturing" || status === "analyzing" || cooldown) return;
    const target = targetRef.current;
    if (!target) {
      setErr("nothing to capture");
      setStatus("error");
      return;
    }
    setCooldown(true);
    setErr("");
    setEvidence([]);
    setStatus("capturing");
    const bg = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg").trim() || "#1a1d24";
    try {
      const targetW = Math.min(1280, target.scrollWidth);
      const scale = targetW / target.scrollWidth;
      const dataUrl = await toPng(target, {
        cacheBust: true,
        pixelRatio: scale,
        backgroundColor: bg,
      });
      setStatus("analyzing");
      const r = await fetch(`${apiBase}/analyze-eeg`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
      const text: string = j.text || "(empty response)";
      setResult(text);
      setStatus("done");
      const names = parseEvidence(text);
      if (names.length) setEvidence(await captureEvidence(names, bg));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setStatus("error");
    }
  };

  const busy = status === "capturing" || status === "analyzing";
  const disabled = busy || cooldown;
  const cta = status === "capturing" ? "capturing…"
            : status === "analyzing" ? "Gemini analyzing…"
            : cooldown ? "wait…"
            : "Analyze";

  return (
    <div className="panel full analyze-panel">
      <div className="panel-head">
        <h2>AI insight</h2>
        <button className="btn small" onClick={run} disabled={disabled}>{cta}</button>
      </div>
      {status === "idle" && (
        <div className="analyze-hint">
          Capture the current pieeg dashboard and ask Gemini for a one-line read
          of the brain state + which panel it used as evidence.
        </div>
      )}
      {status === "error" && (
        <div className="analyze-err">error: {err}</div>
      )}
      {(status === "done" || (busy && result)) && (
        <div className="analyze-result">{result}</div>
      )}
      {evidence.length > 0 && (
        <div className="analyze-evidence">
          {evidence.map(({ name, src }) => (
            <figure key={name} className="analyze-evidence-cell">
              <img src={src} alt={`evidence — ${name}`} />
              <figcaption>{name}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
