"""Pure, clock-injectable match state machine without network operations."""

from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from time import monotonic_ns

from app import policies
from app.constants import COUNTDOWN_MS, MATCH_MS, MAX_AMMO, MAX_HP, TANK_IDS, WIN_KILLS
from app.errors import DecisionRequired, OperationError
from app.protocol import Role, TankSnapshot, WebState


def monotonic_ms() -> int:
    return monotonic_ns() // 1_000_000


class Phase(StrEnum):
    LOBBY = "lobby"
    COUNTDOWN = "countdown"
    RUNNING = "running"
    ENDED = "ended"


@dataclass
class Tank:
    id: int
    player: str | None = None
    online: bool = False
    alive: bool = True
    hp: int = MAX_HP
    ammo: int = MAX_AMMO
    kills: int = 0
    deaths: int = 0
    respawn_ms: int = 0


class GameEngine:
    def __init__(self, clock: Callable[[], int] = monotonic_ms) -> None:
        self.clock = clock
        self.tanks = {tank_id: Tank(tank_id) for tank_id in TANK_IDS}
        self.phase = Phase.LOBBY
        self.deadline_ms: int | None = None
        self.winner: int | None = None
        self.pending_decision: str | None = None

    def enabled(self, tank_id: int) -> bool:
        if self.phase == Phase.LOBBY:
            return True
        return self.phase == Phase.RUNNING and self.tanks[tank_id].alive

    def start(self) -> None:
        if self.phase != Phase.LOBBY:
            raise OperationError("只能在 lobby 阶段开始比赛")
        if any(not tank.online or tank.player is None for tank in self.tanks.values()):
            raise OperationError("两台坦克必须都在线且都有玩家")
        self.phase = Phase.COUNTDOWN
        self.deadline_ms = self.clock() + COUNTDOWN_MS
        self.winner = None

    def reset(self) -> None:
        # The placeholder must run before any data or connection is changed.
        policies.reset_match()

    def note_disconnect(self, role: Role, tank_id: int) -> None:
        if self.phase not in (Phase.COUNTDOWN, Phase.RUNNING):
            return
        try:
            policies.active_match_disconnect(role, tank_id)
        except DecisionRequired as exc:
            self.pending_decision = str(exc)
            raise

    def advance(self) -> list[str]:
        if self.pending_decision is not None:
            raise DecisionRequired(self.pending_decision)
        now = self.clock()
        events: list[str] = []
        if self.phase == Phase.COUNTDOWN and now >= self.deadline_ms:
            self.phase = Phase.RUNNING
            # Anchor the match to the countdown deadline, avoiding scheduler drift.
            self.deadline_ms += MATCH_MS
            events.append("game_start")
        if self.phase == Phase.RUNNING:
            if now >= self.deadline_ms or any(t.kills >= WIN_KILLS for t in self.tanks.values()):
                self._finish()
                events.append("game_end")
        return events

    def _finish(self) -> None:
        first, second = (self.tanks[tank_id] for tank_id in TANK_IDS)
        self.winner = None
        if first.kills != second.kills:
            self.winner = first.id if first.kills > second.kills else second.id
        self.phase = Phase.ENDED
        self.deadline_ms = None

    def snapshot(self) -> WebState:
        remaining = 0
        if self.deadline_ms is not None:
            remaining = max(0, self.deadline_ms - self.clock())
        return WebState(
            status=self.phase.value,
            time_left_ms=remaining,
            winner=self.winner,
            tanks=[TankSnapshot(**vars(self.tanks[tank_id])) for tank_id in TANK_IDS],
        )
