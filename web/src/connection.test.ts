import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSocket } from "./connection";
import { MockArena } from "./mockArena";
class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.sockets.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
const settings = {
  demo: false,
  server: "ws://10.42.0.1:8000",
  role: "player" as const,
  tankId: 1 as const,
  name: "Pilot",
};
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.sockets = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("real WebSocket transport", () => {
  it("never sends driving messages from the spectator connection", () => {
    const conn = openSocket(
      { ...settings, role: "spectator" },
      { status: vi.fn(), message: vi.fn() },
    );
    const ws = FakeSocket.sockets[0];
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "hello" });
    expect(conn.send({ type: "drive", left: 0, right: 0, turret: 0 })).toBe(
      false,
    );
    expect(conn.send({ type: "fire" })).toBe(false);
    expect(conn.send({ type: "match_control", action: "start" })).toBe(true);
    expect(ws.sent).toHaveLength(2);
    conn.close();
  });
  it("registers, replies to JSON heartbeat, then requires state before marking ready", () => {
    const callbacks = { status: vi.fn(), message: vi.fn() };
    const conn = openSocket(settings, callbacks);
    const ws = FakeSocket.sockets[0];
    expect(ws.url).toBe("ws://10.42.0.1:8000/ws/player");
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "hello",
      tank_id: 1,
      name: "Pilot",
    });
    expect(callbacks.status).not.toHaveBeenCalledWith("connected");
    ws.receive({ type: "ping", ts: 987 });
    expect(JSON.parse(ws.sent[1])).toEqual({ type: "pong", ts: 987 });
    ws.receive(new MockArena().snapshot());
    expect(callbacks.status).toHaveBeenCalledWith("connected");
    conn.close();
  });
  it("reconnects after timeout and cancels all retries on cleanup", () => {
    const callbacks = { status: vi.fn(), message: vi.fn() };
    const conn = openSocket(settings, callbacks);
    FakeSocket.sockets[0].open();
    vi.advanceTimersByTime(3250);
    expect(callbacks.status).toHaveBeenCalledWith("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.sockets).toHaveLength(2);
    conn.close();
    vi.advanceTimersByTime(10000);
    expect(FakeSocket.sockets).toHaveLength(2);
  });
  it("shows rejected registration without endlessly retrying", () => {
    const callbacks = { status: vi.fn(), message: vi.fn() };
    const conn = openSocket(settings, callbacks);
    FakeSocket.sockets[0].open();
    FakeSocket.sockets[0].receive({ type: "error", message: "坦克已被占用" });
    FakeSocket.sockets[0].close();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.sockets).toHaveLength(1);
    expect(callbacks.status).toHaveBeenCalledWith("disconnected");
    conn.close();
  });
  it("does not send drive into a congested socket", () => {
    const conn = openSocket(settings, { status: vi.fn(), message: vi.fn() });
    const ws = FakeSocket.sockets[0];
    ws.open();
    ws.bufferedAmount = 20000;
    expect(conn.send({ type: "drive", left: 60, right: 60, turret: 0 })).toBe(
      false,
    );
    expect(ws.readyState).toBe(3);
    conn.close();
  });
});
