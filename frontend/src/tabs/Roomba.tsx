import { AutopilotPanel } from "../components/AutopilotPanel";
import { CameraView } from "../components/CameraView";
import { EegTriggerPanel } from "../components/EegTriggerPanel";
import { EmergencyStop } from "../components/EmergencyStop";
import { Joystick } from "../components/Joystick";
import { TrajectoryMap } from "../components/TrajectoryMap";
import { AppState, TrajectoryStep } from "../types";

export interface RoombaTabProps {
  state: AppState;
  history: TrajectoryStep[];
  apiBase: string;
  camOn: boolean;
  setCamOn: (v: boolean) => void;
}

export function Roomba({ state, history, apiBase, camOn, setCamOn }: RoombaTabProps) {
  const cmd = (c: string) => {
    fetch(`${apiBase}/control/${c}`, { method: "POST" }).catch(() => {});
  };

  const lastCmds = history.slice(-12).reverse();

  return (
    <div className="roomba-wrap compact">
      <EmergencyStop apiBase={apiBase} />

      <CameraView apiBase={apiBase} camOn={camOn} setCamOn={setCamOn} />

      <TrajectoryMap history={history} />

      <div className="panel ctrl-panel">
        <div className="panel-head">
          <h2>Control</h2>
          <div className="ctrl-conn">
            <button className="btn xsmall" onClick={() => fetch(`${apiBase}/control/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })}>conn</button>
            <button className="btn xsmall stop" onClick={() => fetch(`${apiBase}/control/disconnect`, { method: "POST" })}>disc</button>
          </div>
        </div>
        <Joystick onCmd={cmd} />
      </div>

      <EegTriggerPanel apiBase={apiBase} decisionState={state.decisionState} />

      <AutopilotPanel apiBase={apiBase} layout="horizontal" />

      <div className="panel cmds-panel">
        <div className="panel-head">
          <h2>Recent</h2>
          <small>{lastCmds.length === 0 ? "none yet" : `${history.length} total`}</small>
        </div>
        <div className="cmd-strip">
          {lastCmds.length === 0 && <span className="cmd-strip-empty">—</span>}
          {lastCmds.map((c, i) => (
            <span key={i} className={`cmd-chip ${c.ok ? "" : "bad"}`} title={new Date(c.ts * 1000).toLocaleTimeString()}>
              {c.cmd}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
