import { MockArena } from "./mockArena.js";

const record = (v) => typeof v === "object" && v !== null;
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const id = (v) => v === 1 || v === 2;
function isTank(v) {
  return (
    record(v) &&
    id(v.id) &&
    (v.player === null || typeof v.player === "string") &&
    typeof v.online === "boolean" &&
    typeof v.alive === "boolean" &&
    integer(v.hp, 0, 5) &&
    integer(v.ammo, 0, 10) &&
    integer(v.kills) &&
    integer(v.deaths) &&
    integer(v.respawn_ms)
  );
}
export function parseServerMessage(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record(v)) return null;
  if (v.type === "ping" && integer(v.ts)) return v;
  if (v.type === "error" && typeof v.message === "string") return v;
  if (
    v.type === "state" &&
    ["lobby", "countdown", "running", "ended"].includes(String(v.status)) &&
    integer(v.time_left_ms) &&
    (v.winner === null || id(v.winner)) &&
    Array.isArray(v.tanks) &&
    v.tanks.length === 2 &&
    v.tanks.every(isTank) &&
    new Set(v.tanks.map((t) => t.id)).size === 2
  )
    return v;
  if (
    v.type === "event" &&
    id(v.shooter) &&
    id(v.target) &&
    v.shooter !== v.target &&
    (v.kind === "kill" || (v.kind === "hit" && integer(v.hp, 0, 5)))
  )
    return v;
  return null;
}
export function socketUrl(base, role) {
  const url = new URL(base.trim());
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
    throw new Error("请输入有效的 ws:// 或 wss:// 服务器地址");
  url.pathname = `/ws/${role}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
export function hello(settings) {
  return settings.role === "spectator"
    ? { type: "hello" }
    : {
        type: "hello",
        tank_id: settings.tankId,
        name: settings.name.trim() || "Player",
      };
}
export function allowedMessage(role, message) {
  if (message.type === "drive" || message.type === "fire")
    return role === "player";
  if (message.type === "game") return role === "spectator";
  return true;
}
export function canDrive(state, tankId) {
  const tank = state?.tanks.find((t) => t.id === tankId);
  return (
    !!tank?.online &&
    !!tank.alive &&
    (state?.status === "lobby" || state?.status === "running")
  );
}

// One simulation per tab. Switching player/spectator keeps the same match.
export const demoArena = new MockArena();
export function openDemo(settings, callbacks) {
  let closed = false;
  const deliver = () => {
    if (closed) return;
    demoArena.drain().forEach(callbacks.message);
    callbacks.message(demoArena.snapshot());
  };
  demoArena.command(hello(settings), settings, Date.now());
  queueMicrotask(() => {
    if (!closed) {
      callbacks.status("connected");
      deliver();
    }
  });
  const timer = setInterval(() => {
    demoArena.tick(Date.now(), settings.tankId);
    deliver();
  }, 200);
  return {
    send(message) {
      if (closed || !allowedMessage(settings.role, message)) return false;
      demoArena.command(message, settings, Date.now());
      deliver();
      return true;
    },
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
export function openSocket(settings, callbacks) {
  const url = socketUrl(settings.server, settings.role);
  if (
    typeof location !== "undefined" &&
    location.protocol === "https:" &&
    url.startsWith("ws:")
  )
    throw new Error(
      "HTTPS 页面需要 wss://；本地树莓派 ws:// 请从 HTTP 页面连接",
    );
  let ws = null;
  let stopped = false;
  let retry;
  let watchdog;
  let lastReceived = 0;
  let hasState = false;
  let rejectHello = false;
  const send = (message) => {
    if (
      stopped ||
      !allowedMessage(settings.role, message) ||
      ws?.readyState !== WebSocket.OPEN
    )
      return false;
    // Avoid building a stale drive backlog on a congested connection.
    if (ws.bufferedAmount > 16384) {
      ws.close();
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  };
  function connect() {
    if (stopped) return;
    hasState = false;
    rejectHello = false;
    callbacks.status("connecting");
    ws = new WebSocket(url);
    ws.onopen = () => {
      lastReceived = Date.now();
      send(hello(settings));
      watchdog = setInterval(() => {
        if (Date.now() - lastReceived > 3000) {
          callbacks.status("reconnecting");
          ws?.close();
        }
      }, 250);
    };
    ws.onmessage = (event) => {
      if (stopped) return;
      lastReceived = Date.now();
      const message = parseServerMessage(String(event.data));
      if (!message) return;
      if (message.type === "ping") {
        send({ type: "pong", ts: message.ts });
        return;
      }
      if (message.type === "state") {
        hasState = true;
        callbacks.status("connected");
      }
      if (message.type === "error" && !hasState) rejectHello = true;
      callbacks.message(message);
    };
    ws.onerror = () => {
      /* The close event owns retry, preventing duplicate retries. */
    };
    ws.onclose = () => {
      clearInterval(watchdog);
      if (stopped) return;
      // A rejected identity requires user correction, rather than an endless reconnect loop.
      if (rejectHello) {
        callbacks.status("disconnected");
        return;
      }
      callbacks.status("reconnecting");
      retry = setTimeout(connect, 1000);
    };
  }
  connect();
  return {
    send,
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watchdog);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
    },
  };
}
