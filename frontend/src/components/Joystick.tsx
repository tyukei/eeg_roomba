import { useEffect, useRef, useState } from "react";

// Visual constants (SVG units). The viewBox is centered at x=0 with the
// dish hinge at y=50 so the rest position of the knob (above the dish)
// reads as "looking down at an angle" rather than top-down.
const VB = { x: -120, y: -110, w: 240, h: 220 };
const DISH_CX = 0;
const DISH_CY = 50;
const DISH_RX = 96;
const DISH_RY = 24;        // squashed = perspective
const KNOB_R = 24;
const REST_Y = -28;        // rest position above the dish hinge
const MAX_X = 70;          // knob travel — horizontal
const MAX_Y_UP = 36;       // travel up   (perspective shortened)
const MAX_Y_DN = 28;       // travel down (perspective shortened more)
const DEADZONE = 0.22;     // fraction of max before any command fires
const REPEAT_MS = 280;     // re-send the held direction at this cadence

type Dir = "forward" | "back" | "left" | "right" | "stop";

const KEY_TO_DIR: Record<string, Dir> = {
  ArrowUp: "forward", ArrowDown: "back",
  ArrowLeft: "left", ArrowRight: "right",
  " ": "stop", Escape: "stop",
};

function dirFromOffset(nx: number, ny: number): Dir {
  // nx, ny in [-1, 1]. ny is positive when knob is pushed DOWN on screen
  // (i.e. dragged toward the user), which we map to "back".
  const mag = Math.hypot(nx, ny);
  if (mag < DEADZONE) return "stop";
  if (Math.abs(nx) >= Math.abs(ny)) return nx > 0 ? "right" : "left";
  return ny > 0 ? "back" : "forward";
}

export function Joystick({ onCmd }: { onCmd: (c: Dir) => Promise<void> | void }) {
  const [pos, setPos] = useState({ x: 0, y: REST_Y });   // screen-space SVG coords
  const [dir, setDir] = useState<Dir>("stop");
  const [dragging, setDragging] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const ptrRef = useRef<{ id: number; cx: number; cy: number; pxPerUnit: number } | null>(null);
  const lastSentRef = useRef<Dir>("stop");
  const intervalRef = useRef<number | null>(null);

  // ----- send / repeat logic ----------------------------------------------
  const sendIfChanged = (d: Dir) => {
    if (d !== lastSentRef.current) {
      lastSentRef.current = d;
      onCmd(d);
    }
  };

  useEffect(() => {
    if (dragging && dir !== "stop") {
      // Re-issue the held direction so a Roomba that stops on its own
      // (the Arduino sketch auto-halts after ~1s) keeps moving.
      intervalRef.current = window.setInterval(() => onCmd(dir), REPEAT_MS);
      return () => {
        if (intervalRef.current != null) window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, dir]);

  // ----- pointer drag -----------------------------------------------------
  const updateFromClient = (clientX: number, clientY: number) => {
    const p = ptrRef.current;
    if (!p) return;
    // Convert pixel delta to SVG units.
    const dxPx = clientX - p.cx;
    const dyPx = clientY - p.cy;
    let svgDx = dxPx / p.pxPerUnit;
    let svgDy = dyPx / p.pxPerUnit;

    // Clamp horizontal travel.
    if (svgDx >  MAX_X) svgDx =  MAX_X;
    if (svgDx < -MAX_X) svgDx = -MAX_X;
    // Clamp vertical (asymmetric — perspective).
    if (svgDy >  MAX_Y_DN) svgDy =  MAX_Y_DN;
    if (svgDy < -MAX_Y_UP) svgDy = -MAX_Y_UP;

    const x = svgDx;
    const y = REST_Y + svgDy;
    setPos({ x, y });

    const nx = svgDx / MAX_X;
    const ny = svgDy / (svgDy >= 0 ? MAX_Y_DN : MAX_Y_UP);
    const d = dirFromOffset(nx, ny);
    setDir(d);
    sendIfChanged(d);
  };

  const onPointerDown = (e: React.PointerEvent<SVGElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    // SVG viewBox spans VB.w units across r.width px.
    const pxPerUnit = r.width / VB.w;
    // The dish hinge in screen space (where (0,0) of our svg "knob axis" sits).
    // The knob rests at (0, REST_Y) in viewBox; convert hinge offset:
    const cx = r.left + r.width / 2;                          // viewBox x=0 ↔ horizontal center
    const cy = r.top  + (-REST_Y - VB.y) * pxPerUnit;          // viewBox y=REST_Y ↔ rest screen y
    ptrRef.current = { id: e.pointerId, cx, cy, pxPerUnit };
    (e.target as SVGElement).setPointerCapture?.(e.pointerId);
    setDragging(true);
    updateFromClient(e.clientX, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent<SVGElement>) => {
    if (!ptrRef.current || ptrRef.current.id !== e.pointerId) return;
    updateFromClient(e.clientX, e.clientY);
  };

  const release = (e: React.PointerEvent<SVGElement>) => {
    if (!ptrRef.current || ptrRef.current.id !== e.pointerId) return;
    (e.target as SVGElement).releasePointerCapture?.(e.pointerId);
    ptrRef.current = null;
    setDragging(false);
    setPos({ x: 0, y: REST_Y });
    setDir("stop");
    if (lastSentRef.current !== "stop") {
      lastSentRef.current = "stop";
      onCmd("stop");
    }
  };

  // ----- keyboard ---------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const d = KEY_TO_DIR[e.key];
      if (!d) return;
      e.preventDefault();
      lastSentRef.current = d;     // bypass change-detect so each key press echoes
      onCmd(d);
      // brief visual feedback: flash the knob position too
      const k = 0.7;
      if (d === "forward") setPos({ x: 0, y: REST_Y - MAX_Y_UP * k });
      else if (d === "back") setPos({ x: 0, y: REST_Y + MAX_Y_DN * k });
      else if (d === "left") setPos({ x: -MAX_X * k, y: REST_Y });
      else if (d === "right") setPos({ x: MAX_X * k, y: REST_Y });
      else setPos({ x: 0, y: REST_Y });
      setTimeout(() => setPos({ x: 0, y: REST_Y }), 220);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- render -----------------------------------------------------------
  const tiltActive = dragging && dir !== "stop";

  return (
    <div className="joy" ref={wrapRef}>
      <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`}
           className="joy-svg"
           onPointerDown={onPointerDown}
           onPointerMove={onPointerMove}
           onPointerUp={release}
           onPointerCancel={release}>
        <defs>
          <radialGradient id="joy-dish" cx="50%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#3a4258" />
            <stop offset="55%" stopColor="#1c2130" />
            <stop offset="100%" stopColor="#0a0d14" />
          </radialGradient>
          <linearGradient id="joy-stick" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#1a1f2a" />
            <stop offset="38%" stopColor="#3a4458" />
            <stop offset="62%" stopColor="#5a6680" />
            <stop offset="100%" stopColor="#1a1f2a" />
          </linearGradient>
          <radialGradient id="joy-knob" cx="38%" cy="28%" r="70%">
            <stop offset="0%" stopColor="#a6b3cd" />
            <stop offset="40%" stopColor="#5b6884" />
            <stop offset="78%" stopColor="#2c3344" />
            <stop offset="100%" stopColor="#11141d" />
          </radialGradient>
          <radialGradient id="joy-knob-active" cx="38%" cy="28%" r="70%">
            <stop offset="0%"  stopColor="#ffd0c2" />
            <stop offset="40%" stopColor="#d97757" />
            <stop offset="78%" stopColor="#5a2218" />
            <stop offset="100%" stopColor="#1a0a08" />
          </radialGradient>
          <filter id="joy-soft" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
        </defs>

        {/* ground / dish drop shadow */}
        <ellipse cx={DISH_CX} cy={DISH_CY + 12} rx={DISH_RX + 6} ry={DISH_RY + 4}
                 fill="rgba(0,0,0,0.55)" filter="url(#joy-soft)" />

        {/* dish */}
        <ellipse cx={DISH_CX} cy={DISH_CY} rx={DISH_RX} ry={DISH_RY} fill="url(#joy-dish)" />
        {/* dish top rim highlight */}
        <ellipse cx={DISH_CX} cy={DISH_CY - DISH_RY + 2} rx={DISH_RX - 4} ry={2.2}
                 fill="rgba(255,255,255,0.10)" />
        {/* dish inner hole (where the stick comes out) */}
        <ellipse cx={DISH_CX} cy={DISH_CY - 2} rx={18} ry={6}
                 fill="#0a0d14" />
        <ellipse cx={DISH_CX} cy={DISH_CY - 3} rx={16} ry={4}
                 fill="rgba(0,0,0,0.7)" />

        {/* stick — thick line from dish hinge to knob */}
        <line x1={DISH_CX} y1={DISH_CY - 2} x2={pos.x} y2={pos.y + KNOB_R * 0.55}
              stroke="url(#joy-stick)" strokeWidth={16} strokeLinecap="round" />
        {/* stick highlight (top-left side) */}
        <line x1={DISH_CX - 3} y1={DISH_CY - 2} x2={pos.x - 3} y2={pos.y + KNOB_R * 0.55}
              stroke="rgba(255,255,255,0.10)" strokeWidth={4} strokeLinecap="round" />

        {/* knob cast shadow */}
        <ellipse cx={pos.x + 4} cy={pos.y + KNOB_R * 0.9} rx={KNOB_R * 0.95} ry={KNOB_R * 0.35}
                 fill="rgba(0,0,0,0.45)" filter="url(#joy-soft)" />

        {/* knob */}
        <circle cx={pos.x} cy={pos.y} r={KNOB_R}
                fill={tiltActive ? "url(#joy-knob-active)" : "url(#joy-knob)"} />
        {/* knob top-left specular */}
        <ellipse cx={pos.x - KNOB_R * 0.32} cy={pos.y - KNOB_R * 0.38}
                 rx={KNOB_R * 0.35} ry={KNOB_R * 0.18}
                 fill="rgba(255,255,255,0.25)" />
      </svg>

      <div className="joy-readout">
        <span className={`joy-tag ${tiltActive ? "on" : ""}`}>{dir}</span>
        <small>drag the stick · or arrows / space</small>
      </div>
    </div>
  );
}
