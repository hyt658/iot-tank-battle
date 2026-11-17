import type {
  BattleEvent,
  ClientMessage,
  ConnectionSettings,
  ServerMessage,
  StateMessage,
  TankId,
  TankState,
} from "./protocol";

const newTank = (id: TankId): TankState => ({
  id,
  player: id === 1 ? "Player 01" : "Sparring bot",
  online: true,
  alive: true,
  hp: 5,
  ammo: 10,
  kills: 0,
  deaths: 0,
  respawn_ms: 0,
});

/** Local UI simulator only: a permitted shot is a simulated hit, with no IR/physics validation. */
export class MockArena {
  state: StateMessage = {
    type: "state",
    status: "lobby",
    time_left_ms: 0,
    winner: null,
    tanks: [newTank(1), newTank(2)],
  };
  private deadline = 0;
  private lastFire = [-Infinity, -Infinity];
  private respawnAt = [0, 0];
  private protectedUntil = [0, 0];
  private nextAmmo = 0;
  private lastBot = 0;
  private events: ServerMessage[] = [];
  botEnabled = true;
  snapshot(): StateMessage {
    return structuredClone(this.state);
  }
  drain(): ServerMessage[] {
    const events = this.events;
    this.events = [];
    return events;
  }
  command(
    message: ClientMessage,
    settings: ConnectionSettings,
    now: number,
  ): void {
    if (message.type === "hello" && settings.role === "player") {
      this.state.tanks[settings.tankId - 1].player = message.name || "Player";
    }
    if (message.type === "fire" && settings.role === "player")
      this.fire(settings.tankId, now);
    if (message.type === "match_control") {
      if (settings.role !== "spectator") {
        this.error("请在观战计分页管理比赛");
        return;
      }
      if (message.action === "reset") {
        this.reset();
        return;
      }
      if (
        this.state.status !== "lobby" ||
        this.state.tanks.some((t) => !t.online || !t.player)
      ) {
        this.error("需要在准备阶段，且两台坦克和玩家都已就绪");
        return;
      }
      this.reset();
      this.state.status = "countdown";
      this.deadline = now + 3000;
      this.state.time_left_ms = 3000;
    }
  }
  reset(): void {
    this.state = {
      type: "state",
      status: "lobby",
      time_left_ms: 0,
      winner: null,
      tanks: this.state.tanks.map((t) => ({
        ...newTank(t.id),
        player: t.player,
        online: t.online,
      })),
    };
    this.lastFire = [-Infinity, -Infinity];
    this.respawnAt = [0, 0];
    this.protectedUntil = [0, 0];
    this.events = [];
  }
  private error(message: string): void {
    this.events.push({ type: "error", message });
  }
  fire(shooter: TankId, now: number, quiet = false): void {
    const source = this.state.tanks[shooter - 1];
    if (
      !["lobby", "running"].includes(this.state.status) ||
      !source.online ||
      !source.alive
    ) {
      if (!quiet) this.error("坦克当前无法开火");
      return;
    }
    if (now - this.lastFire[shooter - 1] < 1000) {
      if (!quiet) this.error("开火冷却中");
      return;
    }
    if (this.state.status === "running" && source.ammo <= 0) {
      if (!quiet) this.error("没有弹药");
      return;
    }
    this.lastFire[shooter - 1] = now;
    const target = this.state.tanks[shooter === 1 ? 1 : 0];
    if (this.state.status === "running") source.ammo--;
    if (
      !target.online ||
      !target.alive ||
      now < this.protectedUntil[target.id - 1]
    )
      return;
    if (this.state.status === "lobby") {
      this.events.push({
        type: "event",
        kind: "hit",
        shooter,
        target: target.id,
        hp: target.hp,
      });
      return;
    }
    target.hp--;
    if (target.hp > 0) {
      this.events.push({
        type: "event",
        kind: "hit",
        shooter,
        target: target.id,
        hp: target.hp,
      });
      return;
    }
    target.alive = false;
    target.ammo = 0;
    target.deaths++;
    source.kills++;
    target.respawn_ms = 5000;
    this.respawnAt[target.id - 1] = now + 5000;
    this.events.push({
      type: "event",
      kind: "kill",
      shooter,
      target: target.id,
    } satisfies BattleEvent);
    if (source.kills >= 5) this.end();
  }
  private end(): void {
    this.state.status = "ended";
    this.state.time_left_ms = 0;
    const [a, b] = this.state.tanks;
    this.state.winner =
      a.kills === b.kills ? null : a.kills > b.kills ? a.id : b.id;
  }
  tick(now: number, human: TankId = 1): void {
    if (this.state.status === "countdown") {
      this.state.time_left_ms = Math.max(0, this.deadline - now);
      if (now >= this.deadline) {
        this.state.status = "running";
        this.deadline = now + 180000;
        this.nextAmmo = now + 3000;
        this.lastBot = now;
      }
    }
    if (this.state.status !== "running") return;
    this.state.time_left_ms = Math.max(0, this.deadline - now);
    if (now >= this.deadline) {
      this.end();
      return;
    }
    for (const tank of this.state.tanks) {
      if (!tank.alive) {
        tank.respawn_ms = Math.max(0, this.respawnAt[tank.id - 1] - now);
        if (!tank.respawn_ms) {
          tank.alive = true;
          tank.hp = 5;
          tank.ammo = 10;
          this.protectedUntil[tank.id - 1] = now + 2000;
        }
      }
    }
    if (now >= this.nextAmmo) {
      const refill = Math.floor((now - this.nextAmmo) / 3000) + 1;
      for (const tank of this.state.tanks)
        if (tank.alive) tank.ammo = Math.min(10, tank.ammo + refill);
      this.nextAmmo += refill * 3000;
    }
    if (this.botEnabled && now - this.lastBot >= 2400) {
      this.lastBot = now;
      this.fire(human === 1 ? 2 : 1, now, true);
    }
  }
}
