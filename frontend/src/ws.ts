import { useEffect, useRef, useState } from "react";

const WS_URL = (import.meta as any).env?.VITE_WS_URL ?? `ws://${location.hostname}:8080/ws`;

export type WsMsg = { topic: string; payload: string };
export type WsHandler = (topic: string, payload: any) => void;

/**
 * Open a WebSocket to the api server. Auto-reconnects with exponential backoff.
 * The handler is called for each parsed payload; topics arrive interleaved.
 *
 * Returns the live connection status so the UI can show "reconnecting...".
 */
export function useWebSocket(onMsg: WsHandler): "connecting" | "open" | "closed" {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const handlerRef = useRef(onMsg);
  handlerRef.current = onMsg;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let backoff = 500;
    let cancelled = false;
    let timer: number | null = null;

    const open = () => {
      if (cancelled) return;
      setStatus("connecting");
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        backoff = 500;
        setStatus("open");
        ws?.send("hi");
      };
      ws.onmessage = (ev) => {
        try {
          const m: WsMsg = JSON.parse(ev.data);
          let payload: any;
          try { payload = JSON.parse(m.payload); } catch { return; }
          handlerRef.current(m.topic, payload);
        } catch { /* drop */ }
      };
      const onClose = () => {
        if (cancelled) return;
        setStatus("closed");
        timer = window.setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 10_000);
      };
      ws.onclose = onClose;
      ws.onerror = () => ws?.close();
    };

    open();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return status;
}
