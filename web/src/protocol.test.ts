import { describe, expect, it } from "vitest";
import { canDrive, hello, parseServerMessage, socketUrl } from "./protocol";
import { MockArena } from "./mockArena";
import { driveFromKeys } from "./controls";
const settings = {
  demo: false,
  server: "ws://10.42.0.1:8000",
  role: "player" as const,
  tankId: 1 as const,
  name: "Pilot",
};
describe("browser protocol", () => {
  it("sends exact role-specific registration and endpoints", () => {
    expect(hello(settings)).toEqual({
      type: "hello",
      tank_id: 1,
      name: "Pilot",
    });
    expect(hello({ ...settings, role: "spectator" })).toEqual({
      type: "hello",
    });
    expect(socketUrl("http://10.42.0.1:8000/", "player")).toBe(
      "ws://10.42.0.1:8000/ws/player",
    );
    expect(socketUrl("wss://example.test/ws/player", "spectator")).toBe(
      "wss://example.test/ws/spectator",
    );
    expect(() => socketUrl("file:///bad", "player")).toThrow();
  });
  it("accepts protocol state and events and rejects malformed data", () => {
    const state = new MockArena().snapshot();
    expect(parseServerMessage(JSON.stringify(state))).toEqual(state);
    for (const text of [
      "null",
      "broken",
      "{}",
      '{"type":"state","enable":true}',
      JSON.stringify({ ...state, tanks: [state.tanks[0], state.tanks[0]] }),
      JSON.stringify({ ...state, time_left_ms: -1 }),
    ])
      expect(parseServerMessage(text)).toBeNull();
    expect(parseServerMessage('{"type":"ping","ts":123456}')).toEqual({
      type: "ping",
      ts: 123456,
    });
    expect(
      parseServerMessage(
        '{"type":"event","kind":"kill","shooter":1,"target":2}',
      ),
    ).not.toBeNull();
  });
  it("locks driving for disconnect, death, countdown and ended", () => {
    const state = new MockArena().snapshot();
    expect(canDrive(state, 1)).toBe(true);
    expect(canDrive({ ...state, status: "countdown" }, 1)).toBe(false);
    expect(canDrive({ ...state, status: "ended" }, 1)).toBe(false);
    state.tanks[0].alive = false;
    expect(canDrive(state, 1)).toBe(false);
    state.tanks[0].alive = true;
    state.tanks[0].online = false;
    expect(canDrive(state, 1)).toBe(false);
  });
});
describe("differential track controls", () => {
  it("mixes forward, turn, opposing inputs and clamps speed", () => {
    expect(driveFromKeys(new Set(["KeyW"]), 12)).toEqual({
      type: "drive",
      left: 60,
      right: 60,
      turret: 12,
    });
    expect(driveFromKeys(new Set(["KeyD"]), 0)).toEqual({
      type: "drive",
      left: 60,
      right: -60,
      turret: 0,
    });
    expect(driveFromKeys(new Set(["KeyW", "KeyD"]), 0)).toEqual({
      type: "drive",
      left: 100,
      right: 0,
      turret: 0,
    });
    expect(driveFromKeys(new Set(["KeyW", "KeyS"]), 0)).toEqual({
      type: "drive",
      left: 0,
      right: 0,
      turret: 0,
    });
    expect(driveFromKeys(new Set(), -90)).toEqual({
      type: "drive",
      left: 0,
      right: 0,
      turret: -90,
    });
  });
});
