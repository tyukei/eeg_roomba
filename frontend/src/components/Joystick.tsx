import { useEffect, useState } from "react";

const KEY_TO_CMD: Record<string, string> = {
  ArrowUp: "forward", ArrowDown: "back",
  ArrowLeft: "left", ArrowRight: "right",
  " ": "stop", Escape: "stop",
};

export function Joystick({ onCmd }: { onCmd: (c: string) => Promise<void> | void }) {
  const [active, setActive] = useState<string | null>(null);

  const fire = async (cmd: string) => {
    setActive(cmd);
    try { await onCmd(cmd); }
    finally { setTimeout(() => setActive((cur) => (cur === cmd ? null : cur)), 200); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const c = KEY_TO_CMD[e.key];
      if (!c) return;
      e.preventDefault();
      fire(c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="joy" role="group" aria-label="Roomba manual control">
      <div className="joy-base">
        <button type="button" className={`joy-arrow up ${active === "forward" ? "active" : ""}`}
                onClick={() => fire("forward")} aria-label="forward">↑</button>
        <button type="button" className={`joy-arrow left ${active === "left" ? "active" : ""}`}
                onClick={() => fire("left")} aria-label="left">←</button>
        <button type="button" className={`joy-arrow right ${active === "right" ? "active" : ""}`}
                onClick={() => fire("right")} aria-label="right">→</button>
        <button type="button" className={`joy-arrow down ${active === "back" ? "active" : ""}`}
                onClick={() => fire("back")} aria-label="back">↓</button>
        <button type="button" className={`joy-knob ${active === "stop" ? "active" : ""}`}
                onClick={() => fire("stop")} aria-label="stop" title="stop (space)">
          <span className="joy-knob-glyph">■</span>
        </button>
      </div>
    </div>
  );
}
