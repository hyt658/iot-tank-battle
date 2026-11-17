"""Strict JSON message models and role-specific inbound validation."""

import json
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.errors import ProtocolError

TankId = Annotated[int, Field(strict=True, ge=1, le=2)]
NonNegativeInt = Annotated[int, Field(strict=True, ge=0)]
TrackSpeed = Annotated[int, Field(strict=True, ge=-100, le=100)]
TurretAngle = Annotated[int, Field(strict=True, ge=-90, le=90)]
ShotId = Annotated[int, Field(strict=True, ge=0, le=15)]


class Role(StrEnum):
    TANK = "tank"
    PLAYER = "player"
    SPECTATOR = "spectator"


class Message(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class TankHello(Message):
    type: Literal["hello"]
    tank_id: TankId


class PlayerHello(TankHello):
    name: str


class SpectatorHello(Message):
    type: Literal["hello"]


class Pong(Message):
    type: Literal["pong"]
    ts: int


class Drive(Message):
    type: Literal["drive"]
    left: TrackSpeed
    right: TrackSpeed
    turret: TurretAngle


class Fire(Message):
    type: Literal["fire"]


class Hit(Message):
    type: Literal["hit"]
    shooter: TankId
    shot: ShotId


class GameCommand(Message):
    type: Literal["game"]
    action: Literal["start", "reset"]


class Ping(Message):
    type: Literal["ping"] = "ping"
    ts: int


class Error(Message):
    type: Literal["error"] = "error"
    message: str


class TankState(Message):
    type: Literal["state"] = "state"
    enable: bool


class TankEvent(Message):
    type: Literal["event"] = "event"
    kind: Literal["hurt", "death", "hit_confirm", "respawn", "game_start", "game_end"]


class TankSnapshot(Message):
    id: TankId
    player: str | None
    online: bool
    alive: bool
    hp: Annotated[int, Field(ge=0, le=5)]
    ammo: Annotated[int, Field(ge=0, le=10)]
    kills: NonNegativeInt
    deaths: NonNegativeInt
    respawn_ms: NonNegativeInt


class WebState(Message):
    type: Literal["state"] = "state"
    status: Literal["lobby", "countdown", "running", "ended"]
    time_left_ms: NonNegativeInt
    winner: TankId | None
    tanks: Annotated[list[TankSnapshot], Field(min_length=2, max_length=2)]


HELLO_MODELS = {Role.TANK: TankHello, Role.PLAYER: PlayerHello, Role.SPECTATOR: SpectatorHello}
INBOUND_MODELS: dict[Role, dict[str, type[Message]]] = {
    Role.TANK: {"pong": Pong, "hit": Hit},
    Role.PLAYER: {"pong": Pong, "drive": Drive, "fire": Fire},
    Role.SPECTATOR: {"pong": Pong, "game": GameCommand},
}


def _reject_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def decode_message(text: str) -> dict[str, Any]:
    try:
        payload = json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:
        raise ProtocolError("消息必须是合法的 JSON 文本") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("type"), str):
        raise ProtocolError("消息必须是包含字符串 type 字段的 JSON 对象")
    return payload


def parse_message(role: Role, text: str, *, registered: bool) -> Message:
    payload = decode_message(text)
    kind = payload["type"]
    if not registered:
        if kind != "hello":
            raise ProtocolError("连接后的第一条消息必须是 hello")
        model = HELLO_MODELS[role]
    else:
        model = INBOUND_MODELS[role].get(kind)
        if model is None:
            raise ProtocolError(f"{role.value} 连接不允许发送 {kind} 消息")
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        location = ".".join(str(part) for part in exc.errors()[0]["loc"])
        raise ProtocolError(f"消息字段不符合协议：{location}") from exc


def as_payload(message: Message) -> dict[str, Any]:
    return message.model_dump(mode="json")
