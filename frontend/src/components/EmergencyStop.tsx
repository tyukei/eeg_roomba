import { useState } from "react";

export interface EmergencyStopProps {
  apiBase: string;
}

export function EmergencyStop({ apiBase }: EmergencyStopProps) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const fire = async () => {
    setBusy(true);
    setFlash(null);
    try {
      const r = await fetch(`${apiBase}/emergency-stop`, { method: "POST" });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(t || `HTTP ${r.status}`);
      }
      const body = await r.json().catch(() => null);
      // Server always returns 200 with a per-step status map. Treat anything
      // missing or error-prefixed as a partial failure so the operator knows.
      const failed =
        body &&
        Object.values(body).some(
          (v) => typeof v === "string" && v.startsWith("error"),
        );
      setFlash({
        ok: !failed,
        text: failed
          ? `partial stop — check ${Object.entries(body)
              .filter(([, v]) => typeof v === "string" && (v as string).startsWith("error"))
              .map(([k]) => k)
              .join(", ")}`
          : "STOPPED · autopilot off · α-trigger disarmed · Roomba halted",
      });
    } catch (e: any) {
      setFlash({ ok: false, text: `E-STOP failed: ${e?.message ?? e}` });
    } finally {
      setBusy(false);
      // Auto-clear the banner so it doesn't shadow the next manual action.
      setTimeout(() => setFlash(null), 6000);
    }
  };

  return (
    <div className="estop-wrap">
      <button
        type="button"
        className="estop-btn"
        onClick={fire}
        disabled={busy}
        aria-label="Emergency stop: halt autopilot, disarm α-trigger, stop Roomba"
      >
        {busy ? "stopping…" : "⏹ EMERGENCY STOP"}
      </button>
      {flash && (
        <div
          className={`estop-flash ${flash.ok ? "ok" : "bad"}`}
          role={flash.ok ? "status" : "alert"}
          aria-live={flash.ok ? "polite" : "assertive"}
        >
          {flash.text}
        </div>
      )}
    </div>
  );
}
