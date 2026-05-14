import { useEffect, useRef, useState } from "react";

import { AppState } from "../types";

type Msg = { role: "user" | "model"; text: string };

interface Props {
  state: AppState;
  apiBase: string;
}

export function ChatBubble({ state, apiBase }: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: Msg[] = [...messages, { role: "user", text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch(`${apiBase}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: next.slice(-30),
          context: {
            pieegOnline: state.pieegOnline,
            roombaOk: state.roombaOk,
            decisionState: state.decisionState,
            threshold: state.threshold,
            bandsNow: state.bandsNow,
          },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.detail || `HTTP ${r.status}`);
      setMessages([...next, { role: "model", text: j.text || "(no response)" }]);
    } catch (e: any) {
      setMessages([...next, { role: "model", text: `error: ${e?.message ?? e}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={`chat-fab ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)}
              aria-label={open ? "close chat assistant" : "open chat assistant"}>
        {open ? (
          <span className="chat-fab-x">×</span>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"
                  fill="currentColor"/>
          </svg>
        )}
      </button>
      {open && (
        <div className="chat-drawer" role="dialog" aria-label="Chat assistant">
          <div className="chat-head">
            <strong>Insights</strong>
            <small>Gemini · live snapshot</small>
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="close">×</button>
          </div>
          <div className="chat-list" ref={listRef}>
            {messages.length === 0 && (
              <div className="chat-hint">
                {"Ask about the current state, e.g.\n"}
                {"・「今のdecisionがidleなのは何で？」\n"}
                {"・「どのチャネルがαが高い？」\n"}
                {"・「thresholdって何を意味してる？」"}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-msg ${m.role}`}>
                <div className="chat-msg-body">{m.text}</div>
              </div>
            ))}
            {busy && (
              <div className="chat-msg model">
                <div className="chat-msg-body chat-typing">…</div>
              </div>
            )}
          </div>
          <div className="chat-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="質問を入力…（Enter で送信、Shift+Enter で改行）"
              rows={2}
              disabled={busy}
            />
            <button className="btn small" onClick={send} disabled={busy || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
