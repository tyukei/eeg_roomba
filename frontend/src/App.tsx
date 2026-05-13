import { useEffect, useMemo, useRef, useState } from "react";
import UplotReact from "uplot-react";
import uPlot from "uplot";

const NCH = 16;
const LIVE_BUF_SEC = 10;
const LIVE_HZ = 50; // ingest LIVE_DOWNSAMPLE=5 -> 50Hz

const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";
const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? `ws://${location.hostname}:8080/ws`;

type WsMsg = { topic: string; payload: string };

interface State {
  alpha: number[];
  pieegOnline: boolean;
  decisionState: "idle" | "active";
  threshold: { enter: number; exit: number; dwell_ms: number; channels: number[] };
  roombaOk: boolean;
}

const ARROW: Record<string, string> = {
  forward: "↑",
  back: "↓",
  left: "←",
  right: "→",
  stop: "■",
};

const KEY_TO_CMD: Record<string, string> = {
  ArrowUp: "forward",
  ArrowDown: "back",
  ArrowLeft: "left",
  ArrowRight: "right",
  " ": "stop",
  Escape: "stop",
};

export default function App() {
  const [s, setS] = useState<State>({
    alpha: Array(NCH).fill(0),
    pieegOnline: false,
    decisionState: "idle",
    threshold: { enter: 10, exit: 6, dwell_ms: 500, channels: [6, 7] },
    roombaOk: false,
  });
  const [camOn, setCamOn] = useState(false);
  const [activeCmd, setActiveCmd] = useState<string | null>(null);
  const liveRef = useRef<{ ts: number[]; ch: number[][] }>({
    ts: [],
    ch: Array.from({ length: NCH }, () => [] as number[]),
  });
  const [, force] = useState(0);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => ws.send("hi");
    ws.onmessage = (ev) => {
      const m: WsMsg = JSON.parse(ev.data);
      let payload: any;
      try { payload = JSON.parse(m.payload); } catch { return; }
      if (m.topic === "eeg/alpha") {
        setS((p) => ({ ...p, alpha: payload.alpha }));
      } else if (m.topic === "eeg/live") {
        const buf = liveRef.current;
        for (let i = 0; i < payload.ts.length; i++) {
          buf.ts.push(payload.ts[i]);
          for (let c = 0; c < NCH; c++) buf.ch[c].push(payload.samples[i][c]);
        }
        const cutoff = buf.ts.length - LIVE_HZ * LIVE_BUF_SEC;
        if (cutoff > 0) {
          buf.ts.splice(0, cutoff);
          for (let c = 0; c < NCH; c++) buf.ch[c].splice(0, cutoff);
        }
      } else if (m.topic === "pieeg/health") {
        setS((p) => ({ ...p, pieegOnline: !!payload.online }));
      } else if (m.topic === "control/state") {
        setS((p) => ({ ...p, decisionState: payload.state }));
      } else if (m.topic === "control/threshold") {
        setS((p) => ({ ...p, threshold: { ...p.threshold, ...payload } }));
      } else if (m.topic === "roomba/cmd") {
        setS((p) => ({ ...p, roombaOk: !!payload.ok }));
      }
    };
    const tick = setInterval(() => force((x) => x + 1), 200);
    return () => { ws.close(); clearInterval(tick); };
  }, []);

  const cmd = async (c: string) => {
    setActiveCmd(c);
    try {
      await fetch(`${API_BASE}/control/${c}`, { method: "POST" });
    } finally {
      setTimeout(() => setActiveCmd((cur) => (cur === c ? null : cur)), 200);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const c = KEY_TO_CMD[e.key];
      if (!c) return;
      e.preventDefault();
      cmd(c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Detrend each channel for display only (huge DC offsets make the chart unreadable).
  const buf = liveRef.current;
  const chartData = useMemo<uPlot.AlignedData>(() => {
    return [
      buf.ts.slice(),
      ...buf.ch.map((c) => {
        if (c.length === 0) return [];
        let sum = 0;
        for (const v of c) sum += v;
        const mean = sum / c.length;
        return c.map((v) => v - mean);
      }),
    ] as any;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buf.ts.length, buf.ts[buf.ts.length - 1]]);

  const chartOpts = useMemo<uPlot.Options>(() => ({
    width: 800,
    height: 360,
    scales: { x: { time: true }, y: { auto: true } },
    series: [
      {},
      ...Array.from({ length: NCH }, (_, i) => ({
        label: `ch${i}`,
        stroke: `hsl(${(i * 22) % 360} 70% 60%)`,
        width: 1,
      })),
    ],
    axes: [{}, { size: 60 }],
    legend: { show: false },
  }), []);

  const setThresh = async (patch: Partial<State["threshold"]>) => {
    const next = { ...s.threshold, ...patch };
    setS((p) => ({ ...p, threshold: next }));
    await fetch(`${API_BASE}/threshold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
  };

  const selectedChs = s.threshold.channels;
  const currentAlpha = selectedChs.length
    ? selectedChs.reduce((acc, c) => acc + (s.alpha[c] ?? 0), 0) / selectedChs.length
    : 0;
  const alphaZone =
    currentAlpha >= s.threshold.enter ? "high"
    : currentAlpha <= s.threshold.exit ? "low"
    : "mid";

  const maxAlpha = Math.max(1, ...s.alpha);

  return (
    <div className="app">
      <div className="panel main-panel">
        <div className="panel-head">
          <h2>EEG live (16ch)</h2>
          <small>10s window · ch mean removed for display</small>
        </div>
        <div className="chart">
          <UplotReact options={chartOpts} data={chartData} />
        </div>
        <div className="panel-head" style={{ marginTop: 16 }}>
          <h2>α band power</h2>
          <small>decision: ch{selectedChs.join(", ch")}</small>
        </div>
        <div className="alpha-bars">
          {s.alpha.map((v, i) => (
            <div className={`bar ${selectedChs.includes(i) ? "selected" : ""}`} key={i} title={v.toFixed(2)}>
              <div style={{ height: `${Math.min(100, (v / maxAlpha) * 100)}%` }} />
              <span>ch{i}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="side">
        <div className="panel">
          <h2>Status</h2>
          <div className="kv"><span>PiEEG</span><span className={`pill ${s.pieegOnline ? "ok" : "bad"}`}>{s.pieegOnline ? "online" : "offline"}</span></div>
          <div className="kv"><span>Decision</span><span className={`pill ${s.decisionState}`}>{s.decisionState}</span></div>
          <div className="kv"><span>Roomba</span><span className={`pill ${s.roombaOk ? "ok" : "bad"}`}>{s.roombaOk ? "ok" : "—"}</span></div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Control</h2>
            <small>arrows / space</small>
          </div>
          <div className="dpad">
            <div className="dpad-row">
              <span className="dpad-cell" />
              <DPadBtn cmd="forward" active={activeCmd === "forward"} onClick={cmd} />
              <span className="dpad-cell" />
            </div>
            <div className="dpad-row">
              <DPadBtn cmd="left" active={activeCmd === "left"} onClick={cmd} />
              <DPadBtn cmd="stop" active={activeCmd === "stop"} onClick={cmd} variant="stop" />
              <DPadBtn cmd="right" active={activeCmd === "right"} onClick={cmd} />
            </div>
            <div className="dpad-row">
              <span className="dpad-cell" />
              <DPadBtn cmd="back" active={activeCmd === "back"} onClick={cmd} />
              <span className="dpad-cell" />
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Thresholds</h2>
            <span className={`alpha-now ${alphaZone}`}>α = {currentAlpha.toFixed(2)}</span>
          </div>
          <Slider label="enter" min={0} max={50} step={0.5} value={s.threshold.enter}
            onChange={(v) => setThresh({ enter: v })} hint="α ≥ enter で active" />
          <Slider label="exit" min={0} max={50} step={0.5} value={s.threshold.exit}
            onChange={(v) => setThresh({ exit: v })} hint="α ≤ exit で idle" />
          <Slider label="dwell" min={0} max={3000} step={50} value={s.threshold.dwell_ms}
            unit="ms" onChange={(v) => setThresh({ dwell_ms: v })} hint="連続超過時間" />
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Camera</h2>
            <div className="cam-controls">
              <button className="btn small" onClick={async () => {
                await fetch(`${API_BASE}/camera/start`, { method: "POST" });
                setCamOn(true);
              }}>Start</button>
              <button className="btn stop small" onClick={async () => {
                setCamOn(false);
                await fetch(`${API_BASE}/camera/stop`, { method: "POST" });
              }}>Stop</button>
            </div>
          </div>
          <div className="cam-area">
            {camOn ? (
              <img
                key="cam"
                src={`${API_BASE}/camera/stream`}
                alt="camera"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div className="cam-placeholder">press Start to view stream</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DPadBtn({
  cmd, active, onClick, variant,
}: {
  cmd: string;
  active: boolean;
  onClick: (c: string) => void;
  variant?: "stop";
}) {
  return (
    <button
      type="button"
      className={`dpad-btn ${variant ?? "dir"} ${active ? "active" : ""}`}
      onClick={() => onClick(cmd)}
      aria-label={cmd}
      title={cmd}
    >
      {ARROW[cmd]}
    </button>
  );
}

function Slider({
  label, min, max, step, value, onChange, unit, hint,
}: {
  label: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="slider-row">
      <div className="slider-head">
        <label>{label}{hint && <small> · {hint}</small>}</label>
        <input
          type="number"
          min={min} max={max} step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="slider-num"
        />
        {unit && <span className="slider-unit">{unit}</span>}
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
