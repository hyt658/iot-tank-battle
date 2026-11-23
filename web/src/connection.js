const record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(v) && v >= min && v <= max;
const tankId = (v) => v === 1 || v === 2;

export function pageRoute(path) {
  if (path === "/control" || path === "/control/")
    return { role: "control", tankId: null };
  const match = /^\/player\/([12])\/?$/.exec(path);
  return match ? { role: "player", tankId: Number(match[1]) } : null;
}

function isTank(v) {
  return (
    record(v) &&
    tankId(v.id) &&
    (v.player === null || typeof v.player === "string") &&
    typeof v.online === "boolean" &&
    typeof v.alive === "boolean" &&
    integer(v.hp, 0, 5) &&
    integer(v.ammo, 0, 10) &&
    integer(v.kills) &&
    integer(v.deaths) &&
    integer(v.respawn_ms) &&
    integer(v.protected_ms)
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
  if (v.type === "ping" && Number.isSafeInteger(v.ts)) return v;
  if (v.type === "error" && typeof v.message === "string") return v;
  if (
    v.type === "state" &&
    ["lobby", "countdown", "running", "ended"].includes(v.status) &&
    integer(v.time_left_ms) &&
    (v.winner === null || tankId(v.winner)) &&
    Array.isArray(v.tanks) &&
    v.tanks.length === 2 &&
    v.tanks.every(isTank) &&
    new Set(v.tanks.map((t) => t.id)).size === 2
  )
    return v;
  if (
    ["hit", "kill"].includes(v.type) &&
    tankId(v.shooter) &&
    tankId(v.target) &&
    v.shooter !== v.target
  )
    return v;
  return null;
}

export function socketUrl(settings) {
  const url = new URL(settings.server.trim());
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Enter a valid HTTP(S) or WS(S) server address.");
  if (globalThis.location?.protocol === "https:" && url.protocol === "ws:")
    throw new Error(
      "HTTPS pages require wss://. Open the local server over HTTP to use ws://.",
    );
  url.search = "";
  url.hash = "";
  if (settings.role === "control") url.pathname = "/ws/control";
  else if (
    settings.role === "player" &&
    tankId(settings.tankId) &&
    settings.name?.trim()
  ) {
    url.pathname = `/ws/player/${settings.tankId}`;
    url.searchParams.set("name", settings.name.trim());
  } else throw new Error("Choose a valid tank and enter your player name.");
  return url.toString();
}

export function allowedMessage(role, message) {
  if (message.type === "pong") return Number.isSafeInteger(message.ts);
  if (role === "control")
    return message.type === "start" || message.type === "reset";
  if (role !== "player") return false;
  if (message.type === "fire") return true;
  return (
    message.type === "drive" &&
    integer(message.left, -100, 100) &&
    integer(message.right, -100, 100) &&
    integer(message.turret, -90, 90)
  );
}

export function canDrive(state, id) {
  const tank = state?.tanks.find((t) => t.id === id);
  return !!(
    tank?.online &&
    tank.alive &&
    tank.player &&
    ["lobby", "running"].includes(state.status)
  );
}

export function openSocket(settings, callbacks) {
  const url = socketUrl(settings);
  let ws, retry, watchdog;
  let stopped = false;
  let ready = false;
  const send = (message) => {
    if (
      stopped ||
      !allowedMessage(settings.role, message) ||
      ws?.readyState !== WebSocket.OPEN ||
      (!ready && message.type !== "pong")
    )
      return false;
    if (ws.bufferedAmount > 16384) {
      ready = false;
      callbacks.status("reconnecting");
      ws.close();
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  };
  function connect() {
    if (stopped) return;
    ready = false;
    callbacks.status("connecting");
    const socket = new WebSocket(url);
    ws = socket;
    let lastReceived = Date.now();
    // Cover a stalled handshake as well as a lost established connection.
    watchdog = setInterval(() => {
      if (!stopped && ws === socket && Date.now() - lastReceived >= 3000) {
        ready = false;
        callbacks.status("reconnecting");
        socket.close();
      }
    }, 100);
    socket.onmessage = (event) => {
      if (stopped || ws !== socket) return;
      lastReceived = Date.now();
      const message = parseServerMessage(String(event.data));
      if (!message) return;
      if (message.type === "ping") {
        send({ type: "pong", ts: message.ts });
        return;
      }
      if (message.type === "state") {
        ready = true;
        // Apply state before enabling controls, so stale state cannot authorize driving.
        callbacks.message(message);
        callbacks.status("connected");
      } else callbacks.message(message);
    };
    socket.onerror = () => {
      /* onclose handles retries. */
    };
    socket.onclose = (event) => {
      if (stopped || ws !== socket) return;
      ready = false;
      clearInterval(watchdog);
      if (event.code === 4000 || event.code === 4001) {
        callbacks.status("disconnected");
        callbacks.message({
          type: "error",
          message:
            event.reason ||
            (event.code === 4001
              ? "Another player connection took over this tank. Automatic reconnect is stopped."
              : "The server rejected this address. Check your connection settings."),
        });
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
      ready = false;
      clearTimeout(retry);
      clearInterval(watchdog);
      if (ws) {
        ws.onmessage = ws.onclose = ws.onerror = null;
        ws.close();
      }
    },
  };
}
