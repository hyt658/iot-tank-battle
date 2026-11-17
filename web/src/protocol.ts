/** Browser-facing contract from the supplied PROTOCOL(1).md. */
export type TankId = 1 | 2;
export type Role = "player" | "spectator";
export type MatchStatus = "lobby" | "countdown" | "running" | "ended";
export interface TankState {
  id: TankId;
  player: string | null;
  online: boolean;
  alive: boolean;
  hp: number;
  ammo: number;
  kills: number;
  deaths: number;
  respawn_ms: number;
}
export interface StateMessage {
  type: "state";
  status: MatchStatus;
  time_left_ms: number;
  winner: TankId | null;
  tanks: TankState[];
}
export type BattleEvent =
  | { type: "event"; kind: "hit"; shooter: TankId; target: TankId; hp: number }
  | { type: "event"; kind: "kill"; shooter: TankId; target: TankId };
export type ServerMessage =
  | StateMessage
  | BattleEvent
  | { type: "ping"; ts: number }
  | { type: "error"; message: string };
export type Drive = {
  type: "drive";
  left: number;
  right: number;
  turret: number;
};
export type ClientMessage =
  | Drive
  | { type: "hello"; tank_id?: TankId; name?: string }
  | { type: "pong"; ts: number }
  | { type: "fire" }
  | { type: "match_control"; action: "start" | "reset" };
export interface ConnectionSettings {
  demo: boolean;
  server: string;
  role: Role;
  tankId: TankId;
  name: string;
}
export type ConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "disconnected";

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const integer = (
  v: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const id = (v: unknown): v is TankId => v === 1 || v === 2;
function isTank(v: unknown): v is TankState {
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
export function parseServerMessage(text: string): ServerMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record(v)) return null;
  if (v.type === "ping" && integer(v.ts)) return v as ServerMessage;
  if (v.type === "error" && typeof v.message === "string")
    return v as ServerMessage;
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
    return v as unknown as StateMessage;
  if (
    v.type === "event" &&
    id(v.shooter) &&
    id(v.target) &&
    v.shooter !== v.target &&
    (v.kind === "kill" || (v.kind === "hit" && integer(v.hp, 0, 5)))
  )
    return v as BattleEvent;
  return null;
}
export function socketUrl(base: string, role: Role): string {
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
export function hello(settings: ConnectionSettings): ClientMessage {
  return settings.role === "spectator"
    ? { type: "hello" }
    : {
        type: "hello",
        tank_id: settings.tankId,
        name: settings.name.trim() || "Player",
      };
}
export function allowedMessage(role: Role, message: ClientMessage): boolean {
  if (message.type === "drive" || message.type === "fire")
    return role === "player";
  if (message.type === "match_control") return role === "spectator";
  return true;
}
export function canDrive(state: StateMessage | null, tankId: TankId): boolean {
  const tank = state?.tanks.find((t) => t.id === tankId);
  return (
    !!tank?.online &&
    !!tank.alive &&
    (state?.status === "lobby" || state?.status === "running")
  );
}
