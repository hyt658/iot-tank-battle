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
TankEventType = Literal["hurt", "death", "respawn"]
GAME_OUTPUT_TYPES = frozenset({"state", "hurt", "death", "respawn", "hit", "kill"})


class Role(StrEnum):
    TANK = "tank"
    PLAYER = "player"
    CONTROL = "control"


class Message(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


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


class TankFire(Fire):
    shot: ShotId


class Hit(Message):
    type: Literal["hit"]
    shooter: TankId
    shot: ShotId


class GameCommand(Message):
    type: Literal["start", "reset"]


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
    type: TankEventType


class HitEvent(Message):
    type: Literal["hit"] = "hit"
    shooter: TankId
    target: TankId


class KillEvent(Message):
    type: Literal["kill"] = "kill"
    shooter: TankId
    target: TankId


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
    protected_ms: NonNegativeInt


class WebState(Message):
    type: Literal["state"] = "state"
    status: Literal["lobby", "countdown", "running", "ended"]
    time_left_ms: NonNegativeInt
    winner: TankId | None
    tanks: Annotated[list[TankSnapshot], Field(min_length=2, max_length=2)]


INBOUND_MODELS: dict[Role, dict[str, type[Message]]] = {
    Role.TANK: {"pong": Pong, "hit": Hit},
    Role.PLAYER: {"pong": Pong, "drive": Drive, "fire": Fire},
    Role.CONTROL: {"pong": Pong, "start": GameCommand, "reset": GameCommand},
}
KNOWN_TYPES = (GAME_OUTPUT_TYPES | {"ping", "error"}).union(*INBOUND_MODELS.values())


def _reject_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def decode_message(text: str) -> dict[str, Any]:
    try:
        payload = json.loads(text, parse_constant=_reject_constant)
    except (ValueError, RecursionError) as exc:
        raise ProtocolError("Message must be valid JSON text.") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("type"), str):
        raise ProtocolError("Message must be a JSON object with a string type field.")
    return payload


def parse_message(role: Role, text: str) -> Message | None:
    payload = decode_message(text)
    kind = payload["type"]
    if kind not in KNOWN_TYPES:
        return None
    model = INBOUND_MODELS[role].get(kind)
    if model is None:
        raise ProtocolError(
            f"Messages of type {kind!a} are not allowed on {role.value} connections.",
            message_type=kind,
        )
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        location = ".".join(str(part) for part in exc.errors()[0]["loc"])
        raise ProtocolError(f"Invalid message field: {location!a}.", message_type=kind) from exc


def as_payload(message: Message) -> dict[str, Any]:
    return message.model_dump(mode="json")
