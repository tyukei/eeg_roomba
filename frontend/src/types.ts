export const NCH = 16;
export const LIVE_BUF_SEC = 10;
export const LIVE_HZ = 50; // ingest LIVE_DOWNSAMPLE=5 -> 50Hz
export const BANDS_BUF_SEC = 60;
export const BANDS_HZ = 4; // feature emits ~4/sec (hop=250ms)

export const BAND_NAMES = ["delta", "theta", "alpha", "beta", "gamma"] as const;
export type BandName = typeof BAND_NAMES[number];

export const BAND_RANGES: Record<BandName, [number, number]> = {
  delta: [1, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta: [13, 30],
  gamma: [30, 45],
};

// Sequential ramp dark-blue → amber, mapping naturally to low → high frequency.
export const BAND_COLORS: Record<BandName, string> = {
  delta: "#3b5a8a",
  theta: "#5e87b8",
  alpha: "#86b5d9",
  beta:  "#c9a96e",
  gamma: "#d97757",
};

export interface Threshold {
  enter: number;
  exit: number;
  dwell_ms: number;
  channels: number[];
}

export interface AppState {
  bandsNow: Record<BandName, number[]>; // current per-channel value
  pieegOnline: boolean;
  decisionState: "idle" | "active";
  threshold: Threshold;
  roombaOk: boolean;
}

export interface TrajectoryStep {
  ts: number;
  cmd: string;
  ok: boolean;
}
