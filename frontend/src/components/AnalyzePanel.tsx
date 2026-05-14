import { useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";

interface Props {
  apiBase: string;
  /** Ref of the DOM node to screenshot — typically the pieeg tab root. */
  targetRef: React.RefObject<HTMLDivElement>;
}

type Status = "idle" | "capturing" | "analyzing" | "done" | "error";

export function AnalyzePanel({ apiBase, targetRef }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [cooldown, setCooldown] = useState(false);   // throttle window — button disabled

  useEffect(() => {
    if (!cooldown) return;
    const t = window.setTimeout(() => setCooldown(false), 1500);
    return () => window.clearTimeout(t);
  }, [cooldown]);

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
    setStatus("capturing");
    try {
      // Cap render width to ~1280 to keep the upload reasonable.
      const targetW = Math.min(1280, target.scrollWidth);
      const scale = targetW / target.scrollWidth;
      const dataUrl = await toPng(target, {
        cacheBust: true,
        pixelRatio: scale,           // < 1 shrinks; ≥1 keeps full size
        backgroundColor: getComputedStyle(document.documentElement)
          .getPropertyValue("--bg").trim() || "#1a1d24",
      });
      setStatus("analyzing");
      const r = await fetch(`${apiBase}/analyze-eeg`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
      setResult(j.text || "(empty response)");
      setStatus("done");
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
    </div>
  );
}
