"use strict";

// The server stops the Roomba if a move is not refreshed within 800 ms, so a
// held button has to re-send well inside that window.
const HOLD_REFRESH_MS = 300;
const STATE_POLL_MS = 3000;

const $ = (id) => document.getElementById(id);
const CHARGING = {
  0: "なし", 1: "回復中", 2: "充電中", 3: "維持充電", 4: "待機", 5: "異常",
};

let ws = null;
let wsReady = false;
let heldCmd = null;
let holdTimer = null;
let toastTimer = null;

/* ---------- command transport ---------- */

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let socket;
  try {
    socket = new WebSocket(`${proto}://${location.host}/ws/control`);
  } catch {
    return; // fall back to POST /command/*
  }
  ws = socket;
  socket.addEventListener("open", () => { wsReady = true; });
  socket.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!data.ok) toast(data.error || "コマンド失敗", true);
    } catch { /* ignore malformed frames */ }
  });
  socket.addEventListener("close", () => {
    wsReady = false;
    ws = null;
    setTimeout(connectWs, 2000);
  });
  socket.addEventListener("error", () => { socket.close(); });
}

async function send(cmd) {
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ cmd }));
    return;
  }
  try {
    const res = await fetch(`/command/${cmd}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.detail || `送信失敗: ${cmd}`, true);
    }
  } catch {
    toast("通信できません", true);
  }
}

/* ---------- hold-to-drive ---------- */

function beginHold(button, cmd) {
  if (heldCmd) return;
  heldCmd = cmd;
  button.classList.add("active");
  navigator.vibrate?.(10);
  send(cmd);
  holdTimer = window.setInterval(() => send(cmd), HOLD_REFRESH_MS);
}

function endHold() {
  if (!heldCmd) return;
  window.clearInterval(holdTimer);
  holdTimer = null;
  heldCmd = null;
  document.querySelectorAll(".dir.active").forEach((b) => b.classList.remove("active"));
  send("stop");
}

for (const button of document.querySelectorAll(".dir")) {
  const cmd = button.dataset.cmd;
  button.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    // Capture so a thumb that drifts off the button keeps driving; the
    // matching pointerup still lands here and stops.
    button.setPointerCapture?.(ev.pointerId);
    beginHold(button, cmd);
  });
  button.addEventListener("pointerup", endHold);
  button.addEventListener("pointercancel", endHold);
  button.addEventListener("contextmenu", (ev) => ev.preventDefault());
}

// Anything that takes the page out of the driver's hands is a stop.
window.addEventListener("blur", endHold);
window.addEventListener("pagehide", endHold);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) endHold();
});

$("stop").addEventListener("click", () => {
  endHold();
  navigator.vibrate?.(30);
  send("stop");
});

for (const button of document.querySelectorAll(".mode")) {
  button.addEventListener("click", () => send(button.dataset.cmd));
}

/* ---------- state ---------- */

function setConnected(ok, label) {
  $("conn").classList.toggle("ok", ok);
  $("conn-text").textContent = label;
}

function chip(id, value, alert) {
  $(id).textContent = value;
  $(id).closest(".chip").classList.toggle("alert", Boolean(alert));
}

function renderState(state) {
  setConnected(state.connected, state.connected ? (state.port || "接続済み") : "未接続");

  const sensor = state.sensor || {};
  const charge = Number(sensor.charge_mah);
  const capacity = Number(sensor.capacity_mah);
  const percent = capacity > 0 && charge >= 0 ? Math.round((charge / capacity) * 100) : null;
  chip("t-battery", percent === null ? "—" : `${percent}%`, percent !== null && percent < 20);
  chip("t-charge", CHARGING[sensor.charging_state] ?? "—", false);

  const bumped = sensor.bump_left === true || sensor.bump_right === true;
  chip("t-bump", "bump_left" in sensor ? (bumped ? "接触" : "なし") : "—", bumped);
  const cliff = sensor.cliff === true;
  chip("t-cliff", "cliff" in sensor ? (cliff ? "検知" : "なし") : "—", cliff);
}

async function pollState() {
  // Reading sensors holds the Arduino's serial link for ~0.75 s, so never do
  // it while a button is held.
  if (heldCmd) return;
  try {
    const res = await fetch("/state");
    if (!res.ok) throw new Error(String(res.status));
    renderState(await res.json());
  } catch {
    setConnected(false, "サーバ応答なし");
  }
}

/* ---------- settings ---------- */

const settings = $("settings");
$("settings-btn").addEventListener("click", () => {
  settings.hidden = !settings.hidden;
  $("settings-btn").setAttribute("aria-expanded", String(!settings.hidden));
  if (!settings.hidden) loadPorts();
});

function settingsMsg(text, isError) {
  $("settings-msg").textContent = text;
  $("settings-msg").classList.toggle("error", Boolean(isError));
}

async function loadPorts() {
  try {
    const { ports, current } = await (await fetch("/ports")).json();
    const select = $("port");
    select.innerHTML = "";
    for (const port of ports) {
      const option = document.createElement("option");
      option.value = option.textContent = port;
      option.selected = port === current;
      select.append(option);
    }
    if (!ports.length) settingsMsg("シリアルポートが見つかりません", true);
  } catch {
    settingsMsg("ポート一覧を取得できません", true);
  }
}

$("reload-ports").addEventListener("click", loadPorts);

$("connect").addEventListener("click", async () => {
  settingsMsg("接続中…");
  try {
    const res = await fetch("/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: $("port").value, baud_rate: 9600 }),
    });
    const body = await res.json();
    settingsMsg(res.ok ? `接続しました (${body.port})` : body.detail, !res.ok);
  } catch {
    settingsMsg("接続に失敗しました", true);
  }
  pollState();
});

$("disconnect").addEventListener("click", async () => {
  await fetch("/disconnect", { method: "POST" }).catch(() => {});
  settingsMsg("切断しました");
  pollState();
});

/* ---------- camera ---------- */

const cameraToggle = $("camera-toggle");
const cameraPanel = $("camera-panel");
const cameraFeed = $("camera-feed");

function cameraMsg(text) { $("camera-msg").textContent = text; }

async function startCamera() {
  cameraPanel.hidden = false;
  cameraMsg("カメラ起動中…");
  try {
    const res = await fetch("/camera/start", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      cameraMsg(`カメラを使えません: ${body.detail || res.status}`);
      cameraToggle.checked = false;
      return;
    }
  } catch {
    cameraMsg("カメラ起動に失敗しました");
    cameraToggle.checked = false;
    return;
  }
  // Cache-bust so a re-enable restarts the MJPEG stream instead of reusing
  // the closed one.
  cameraFeed.src = `/camera/stream?t=${Date.now()}`;
}

function stopCamera() {
  cameraFeed.removeAttribute("src");
  cameraPanel.hidden = true;
  cameraMsg("");
  fetch("/camera/stop", { method: "POST" }).catch(() => {});
}

cameraFeed.addEventListener("load", () => cameraMsg(""));
cameraFeed.addEventListener("error", () => {
  if (cameraToggle.checked) cameraMsg("映像を取得できません");
});

cameraToggle.addEventListener("change", () => {
  if (cameraToggle.checked) {
    startCamera();
    localStorage.setItem("camera", "1");
  } else {
    stopCamera();
    localStorage.setItem("camera", "0");
  }
});

async function initCamera() {
  try {
    const status = await (await fetch("/camera/status")).json();
    if (!status.opencv_installed || !status.available) {
      cameraToggle.disabled = true;
      settingsMsg("カメラが接続されていません");
      return;
    }
  } catch {
    cameraToggle.disabled = true;
    return;
  }
  // A driver looking at the phone wants the view by default; only an
  // explicit opt-out keeps it off.
  if (localStorage.getItem("camera") !== "0") {
    cameraToggle.checked = true;
    startCamera();
  }
}

/* ---------- misc ---------- */

function toast(text, isError) {
  const node = $("toast");
  node.textContent = text;
  node.classList.toggle("error", Boolean(isError));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.textContent = ""; }, 4000);
}

// Driving with the screen blanking every 30 s is unusable.
async function keepAwake() {
  try { await navigator.wakeLock?.request("screen"); } catch { /* unsupported */ }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) keepAwake();
});

connectWs();
pollState();
initCamera();
keepAwake();
window.setInterval(pollState, STATE_POLL_MS);
