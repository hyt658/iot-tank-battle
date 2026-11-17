import { describe, expect, it } from "vitest";
import { MockArena } from "./mockArena";
const spectator = {
  demo: true,
  server: "",
  role: "spectator" as const,
  tankId: 1 as const,
  name: "Pilot",
};
function start() {
  const arena = new MockArena();
  arena.botEnabled = false;
  arena.command({ type: "match_control", action: "start" }, spectator, 0);
  arena.tick(3000);
  return arena;
}
describe("simulated match", () => {
  it("keeps practice HP and ammo unchanged and respects cooldown", () => {
    const arena = new MockArena();
    arena.fire(1, 0);
    arena.fire(1, 50);
    expect(arena.state.tanks[0].ammo).toBe(10);
    expect(arena.state.tanks[1].hp).toBe(5);
    expect(arena.drain()).toContainEqual({
      type: "error",
      message: "开火冷却中",
    });
  });
  it("only lets spectators start and resets after confirmation", () => {
    const arena = new MockArena();
    arena.command(
      { type: "match_control", action: "start" },
      { ...spectator, role: "player" },
      0,
    );
    expect(arena.state.status).toBe("lobby");
    arena.command({ type: "match_control", action: "start" }, spectator, 0);
    expect(arena.state.status).toBe("countdown");
    arena.tick(2999);
    expect(arena.state.time_left_ms).toBe(1);
    arena.tick(3000);
    expect(arena.state.status).toBe("running");
    expect(arena.state.time_left_ms).toBe(180000);
    arena.command({ type: "match_control", action: "reset" }, spectator, 4000);
    expect(arena.state.status).toBe("lobby");
    expect(arena.state.tanks[0].kills).toBe(0);
  });
  it("kills, respawns after 5s and protects respawn for 2s", () => {
    const arena = start();
    for (let i = 0; i < 5; i++) arena.fire(1, 3000 + i * 1000);
    expect(arena.state.tanks[1]).toMatchObject({
      hp: 0,
      alive: false,
      deaths: 1,
      respawn_ms: 5000,
    });
    expect(arena.state.tanks[0].kills).toBe(1);
    arena.tick(11999);
    expect(arena.state.tanks[1].alive).toBe(false);
    arena.tick(12000);
    expect(arena.state.tanks[1]).toMatchObject({
      alive: true,
      hp: 5,
      ammo: 10,
      respawn_ms: 0,
    });
    arena.fire(1, 12000);
    expect(arena.state.tanks[1].hp).toBe(5);
    arena.fire(1, 14000);
    expect(arena.state.tanks[1].hp).toBe(4);
  });
  it("restores ammunition and ends after 3 minutes with tie or winner", () => {
    const arena = start();
    arena.fire(1, 3000);
    expect(arena.state.tanks[0].ammo).toBe(9);
    arena.tick(6000);
    expect(arena.state.tanks[0].ammo).toBe(10);
    arena.tick(183000);
    expect(arena.state).toMatchObject({
      status: "ended",
      winner: null,
      time_left_ms: 0,
    });
    const other = start();
    other.state.tanks[1].kills = 2;
    other.tick(183000);
    expect(other.state.winner).toBe(2);
  });
  it("ends immediately at five kills and blocks further firing", () => {
    const arena = start();
    arena.state.tanks[0].kills = 4;
    arena.state.tanks[1].hp = 1;
    arena.fire(1, 3000);
    expect(arena.state).toMatchObject({ status: "ended", winner: 1 });
    const ammo = arena.state.tanks[0].ammo;
    arena.fire(1, 5000);
    expect(arena.state.tanks[0].ammo).toBe(ammo);
  });
});
