import { useState } from "react";

interface Props {
  apiBase: string;
  camOn: boolean;
  setCamOn: (v: boolean) => void;
  compact?: boolean;
}

/**
 * MJPEG-based camera preview. The image element is keyed on `camKey`
 * so a fresh request is issued every time the user toggles the stream,
 * working around browsers that cache the long-lived MJPEG response.
 */
export function CameraView({ apiBase, camOn, setCamOn, compact }: Props) {
  const [camKey, setCamKey] = useState(0);
  const [camStatus, setCamStatus] = useState<"idle" | "loading" | "live" | "error">(
    camOn ? "loading" : "idle",
  );

  return (
    <div className={`panel cam-panel ${compact ? "cam-panel-compact" : ""}`}>
      <div className="panel-head">
        <h2>Camera</h2>
        <div className="cam-controls">
          <button
            className="btn small"
            onClick={async () => {
              setCamStatus("loading");
              await fetch(`${apiBase}/camera/start`, { method: "POST" }).catch(() => {});
              setCamKey((k) => k + 1);
              setCamOn(true);
            }}
          >
            Start
          </button>
          <button
            className="btn small stop"
            onClick={async () => {
              setCamOn(false);
              setCamStatus("idle");
              await fetch(`${apiBase}/camera/stop`, { method: "POST" }).catch(() => {});
            }}
          >
            Stop
          </button>
        </div>
      </div>
      <div className="cam-area">
        {camOn ? (
          <>
            <img
              src={`${apiBase}/camera/stream?t=${camKey}`}
              alt="camera"
              key={`cam-${camKey}`}
              onLoad={() => setCamStatus("live")}
              onError={() => setCamStatus("error")}
            />
            {camStatus !== "live" && (
              <div className="cam-overlay">
                {camStatus === "error" ? "stream failed — try Stop then Start" : "connecting to camera…"}
              </div>
            )}
          </>
        ) : (
          <div className="cam-overlay">press Start to begin preview</div>
        )}
      </div>
    </div>
  );
}
