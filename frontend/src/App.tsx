import { useEffect, useRef, useState } from "react";

import { Live } from "./tabs/Live";
import { Bands } from "./tabs/Bands";
import { Brain } from "./tabs/Brain";
import { Trajectory } from "./tabs/Trajectory";
import { useWebSocket } from "./ws";
import {
  AppState, BAND_NAMES, BandName, BANDS_BUF_SEC, BANDS_HZ,
  LIVE_BUF_SEC, LIVE_HZ, NCH, Threshold, TrajectoryStep,
} from "./types";

const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";

type Tab = "live" | "bands" | "brain" | "trajectory";

const emptyBands = (): Record<BandName, number[]> =>
  Object.fromEntries(BAND_NAMES.map((b) => [b, Array(NCH).fill(0)])) as any;

const emptyBandsBuf = (): Record<BandName, number[][]> =>
  Object.fromEntries(BAND_NAMES.map((b) => [b, Array.from({ length: NCH }, () => [] as number[])])) as any;

export default function App() {
  const [tab, setTab] = useState<Tab>("live");
  const [s, setS] = useState<AppState>({
    bandsNow: emptyBands(),
    pieegOnline: false,
    decisionState: "idle",
    threshold: { enter: 10, exit: 6, dwell_ms: 500, channels: [6, 7] },
    roombaOk: false,
  });
  const [camOn, setCamOn] = useState(false);
  const [, force] = useState(0);
  const [trajHistory, setTrajHistory] = useState<TrajectoryStep[]>([]);

  const liveBuf = useRef<{ ts: number[]; ch: number[][] }>({
    ts: [], ch: Array.from({ length: NCH }, () => [] as number[]),
  });
  const bandsBuf = useRef<{ ts: number[]; bands: Record<BandName, number[][]> }>({
    ts: [], bands: emptyBandsBuf(),
  });

  const wsStatus = useWebSocket((topic, payload) => {
    if (topic === "eeg/alpha") {
      const bn: Record<BandName, number[]> = {
        delta: payload.delta ?? s.bandsNow.delta,
        theta: payload.theta ?? s.bandsNow.theta,
        alpha: payload.alpha ?? s.bandsNow.alpha,
        beta: payload.beta ?? s.bandsNow.beta,
        gamma: payload.gamma ?? s.bandsNow.gamma,
      };
      setS((p) => ({ ...p, bandsNow: bn }));
      const buf = bandsBuf.current;
      buf.ts.push(payload.ts);
      for (const b of BAND_NAMES) {
        const arr = payload[b];
        if (!Array.isArray(arr)) continue;
        for (let c = 0; c < NCH; c++) buf.bands[b][c].push(arr[c]);
      }
      const cutoff = buf.ts.length - BANDS_BUF_SEC * BANDS_HZ;
      if (cutoff > 0) {
        buf.ts.splice(0, cutoff);
        for (const b of BAND_NAMES) {
          for (let c = 0; c < NCH; c++) buf.bands[b][c].splice(0, cutoff);
        }
      }
    } else if (topic === "eeg/live") {
      const buf = liveBuf.current;
      for (let i = 0; i < payload.ts.length; i++) {
        buf.ts.push(payload.ts[i]);
        for (let c = 0; c < NCH; c++) buf.ch[c].push(payload.samples[i][c]);
      }
      const cutoff = buf.ts.length - LIVE_HZ * LIVE_BUF_SEC;
      if (cutoff > 0) {
        buf.ts.splice(0, cutoff);
        for (let c = 0; c < NCH; c++) buf.ch[c].splice(0, cutoff);
      }
    } else if (topic === "pieeg/health") {
      setS((p) => ({ ...p, pieegOnline: !!payload.online }));
    } else if (topic === "control/state") {
      setS((p) => ({ ...p, decisionState: payload.state }));
    } else if (topic === "control/threshold") {
      setS((p) => ({ ...p, threshold: { ...p.threshold, ...payload } }));
    } else if (topic === "roomba/cmd") {
      setS((p) => ({ ...p, roombaOk: !!payload.ok }));
      setTrajHistory((h) => {
        const next = [...h, { ts: payload.ts, cmd: payload.cmd, ok: !!payload.ok }];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }
  });

  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 200);
    return () => clearInterval(t);
  }, []);

  const setThresh = async (patch: Partial<Threshold>) => {
    const next = { ...s.threshold, ...patch };
    setS((p) => ({ ...p, threshold: next }));
    await fetch(`${API_BASE}/threshold`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
  };

  return (
    <div className="root">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <strong>eeg_roomba</strong>
        </div>
        <nav className="tabs">
          {(["live", "bands", "brain", "trajectory"] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="ws-badge">
          <span className={`ws-dot ${wsStatus}`} />
          <small>ws: {wsStatus}</small>
        </div>
      </header>

      <main className="content">
        {tab === "live" && (
          <Live state={s} liveBuf={liveBuf} tick={0} apiBase={API_BASE}
                setThresh={setThresh} camOn={camOn} setCamOn={setCamOn} />
        )}
        {tab === "bands" && <Bands bandsBuf={bandsBuf} tick={0} />}
        {tab === "brain" && <Brain state={s} />}
        {tab === "trajectory" && <Trajectory history={trajHistory} />}
      </main>
    </div>
  );
}
