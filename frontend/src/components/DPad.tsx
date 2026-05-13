import { useEffect, useState } from "react";

const ARROW: Record<string, string> = {
  forward: "↑", back: "↓", left: "←", right: "→", stop: "■",
};

const KEY_TO_CMD: Record<string, string> = {
  ArrowUp: "forward", ArrowDown: "back",
  ArrowLeft: "left", ArrowRight: "right",
  " ": "stop", Escape: "stop",
};

export function DPad({ onCmd }: { onCmd: (c: string) => Promise<void> | void }) {
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
    <div className="dpad">
      <div className="dpad-row">
        <span className="dpad-cell" />
        <Btn cmd="forward" active={active === "forward"} onClick={fire} />
        <span className="dpad-cell" />
      </div>
      <div className="dpad-row">
        <Btn cmd="left" active={active === "left"} onClick={fire} />
        <Btn cmd="stop" active={active === "stop"} onClick={fire} variant="stop" />
        <Btn cmd="right" active={active === "right"} onClick={fire} />
      </div>
      <div className="dpad-row">
        <span className="dpad-cell" />
        <Btn cmd="back" active={active === "back"} onClick={fire} />
        <span className="dpad-cell" />
      </div>
    </div>
  );
}

function Btn({
  cmd, active, onClick, variant,
}: { cmd: string; active: boolean; onClick: (c: string) => void; variant?: "stop" }) {
  return (
    <button
      type="button"
      className={`dpad-btn ${variant ?? "dir"} ${active ? "active" : ""}`}
      onClick={() => onClick(cmd)}
      aria-label={cmd}
      title={cmd}
    >{ARROW[cmd]}</button>
  );
}
