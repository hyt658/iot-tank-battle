import {
  allowedMessage,
  hello,
  parseServerMessage,
  socketUrl,
} from "./protocol";
import type {
  ClientMessage,
  ConnectionSettings,
  ConnectionStatus,
  ServerMessage,
} from "./protocol";
import { MockArena } from "./mockArena";

export interface Connection {
  send(message: ClientMessage): boolean;
  close(): void;
}
export interface Callbacks {
  status(status: ConnectionStatus): void;
  message(message: ServerMessage): void;
}
// One simulation per tab. Switching player/spectator keeps the same match.
export const demoArena = new MockArena();

export function openDemo(
  settings: ConnectionSettings,
  callbacks: Callbacks,
): Connection {
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

export function openSocket(
  settings: ConnectionSettings,
  callbacks: Callbacks,
): Connection {
  const url = socketUrl(settings.server, settings.role);
  if (
    typeof location !== "undefined" &&
    location.protocol === "https:" &&
    url.startsWith("ws:")
  )
    throw new Error(
      "HTTPS 页面需要 wss://；本地树莓派 ws:// 请从 HTTP 页面连接",
    );
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let lastReceived = 0;
  let hasState = false;
  let rejectHello = false;
  const send = (message: ClientMessage): boolean => {
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
