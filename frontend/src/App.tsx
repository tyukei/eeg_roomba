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

export default function App() {
  const [s, setS] = useState<State>({
    alpha: Array(NCH).fill(0),
    pieegOnline: false,
    decisionState: "idle",
    threshold: { enter: 10, exit: 6, dwell_ms: 500, channels: [6, 7] },
    roombaOk: false,
  });
  const [camOn, setCamOn] = useState(false);
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

  const buf = liveRef.current;
  const chartData: uPlot.AlignedData =
    [buf.ts.slice(), ...buf.ch.map((c) => c.slice())] as any;

  const chartOpts = useMemo<uPlot.Options>(() => ({
    width: 800,
    height: 480,
    scales: { x: { time: true } },
    series: [
      {},
      ...Array.from({ length: NCH }, (_, i) => ({
        label: `ch${i}`,
        stroke: `hsl(${(i * 22) % 360} 70% 60%)`,
        width: 1,
      })),
    ],
    axes: [{}, { size: 80 }],
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

  const cmd = (c: string) => fetch(`${API_BASE}/control/${c}`, { method: "POST" });

  const maxAlpha = Math.max(1, ...s.alpha);

  return (
    <div className="app">
      <div className="panel">
        <h2>EEG live (16ch)</h2>
        <div className="chart">
          <UplotReact options={chartOpts} data={chartData} />
        </div>
        <h2 style={{ marginTop: 16 }}>α band power (per channel)</h2>
        <div className="alpha-bars">
          {s.alpha.map((v, i) => (
            <div className="bar" key={i} title={`${v.toFixed(2)}`}>
              <div style={{ height: `${(v / maxAlpha) * 100}%` }} />
              <span>ch{i}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>Status</h2>
        <div className="row">
          PiEEG: <span className={`tag ${s.pieegOnline ? "active" : "off"}`}>{s.pieegOnline ? "online" : "offline"}</span>
        </div>
        <div className="row">
          Decision: <span className={`tag ${s.decisionState}`}>{s.decisionState}</span>
        </div>
        <div className="row">
          Roomba HTTP: <span className={`tag ${s.roombaOk ? "active" : "off"}`}>{s.roombaOk ? "ok" : "—"}</span>
        </div>

        <h2 style={{ marginTop: 16 }}>Thresholds</h2>
        <div className="row">
          <small>enter: {s.threshold.enter.toFixed(2)}</small>
        </div>
        <input type="range" min={0} max={50} step={0.5}
          value={s.threshold.enter}
          onChange={(e) => setThresh({ enter: Number(e.target.value) })} />
        <div className="row"><small>exit: {s.threshold.exit.toFixed(2)}</small></div>
        <input type="range" min={0} max={50} step={0.5}
          value={s.threshold.exit}
          onChange={(e) => setThresh({ exit: Number(e.target.value) })} />
        <div className="row"><small>dwell: {s.threshold.dwell_ms} ms</small></div>
        <input type="range" min={0} max={3000} step={50}
          value={s.threshold.dwell_ms}
          onChange={(e) => setThresh({ dwell_ms: Number(e.target.value) })} />

        <h2 style={{ marginTop: 16 }}>Manual control</h2>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="btn" onClick={() => cmd("forward")}>Forward</button>
          <button className="btn" onClick={() => cmd("back")}>Back</button>
          <button className="btn" onClick={() => cmd("left")}>Left</button>
          <button className="btn" onClick={() => cmd("right")}>Right</button>
          <button className="btn stop" onClick={() => cmd("stop")}>Stop</button>
        </div>

        <h2 style={{ marginTop: 16 }}>Camera</h2>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="btn"
            onClick={async () => {
              await fetch(`${API_BASE}/camera/start`, { method: "POST" });
              setCamOn(true);
            }}
          >Start</button>
          <button
            className="btn stop"
            onClick={async () => {
              setCamOn(false);
              await fetch(`${API_BASE}/camera/stop`, { method: "POST" });
            }}
          >Stop</button>
        </div>
        {camOn && (
          <img
            key={camOn ? "on" : "off"}
            src={`${API_BASE}/camera/stream`}
            alt="camera"
            style={{ marginTop: 8, width: "100%", maxWidth: 640, borderRadius: 4 }}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        )}
      </div>
    </div>
  );
}
