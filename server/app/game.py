"""Clock-injectable match, firing, hit validation, and life-cycle rules."""

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from time import monotonic_ns

from app.constants import (
    AMMO_REFILL_MS,
    COUNTDOWN_MS,
    FIRE_COOLDOWN_MS,
    HIT_WINDOW_MS,
    MATCH_MS,
    MAX_AMMO,
    MAX_HP,
    RESPAWN_MS,
    SHOT_COUNT,
    SPAWN_PROTECTION_MS,
    TANK_IDS,
    WIN_KILLS,
)
from app.delivery import DeliveryReceipt
from app.errors import OperationError
from app.protocol import TankSnapshot, WebState

logger = logging.getLogger(__name__)


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
    life_id: int = 0
    respawn_at_ms: int | None = None
    protected_until_ms: int = 0
    next_ammo_ms: int | None = None


@dataclass
class GameUpdate:
    changed: bool = False
    tank_events: list[tuple[int, str]] = field(default_factory=list)
    failed_fires: list[int] = field(default_factory=list)


@dataclass
class Shot:
    shooter: int
    shot: int
    created_at_ms: int
    round_id: int
    life_id: int
    charged_ammo: bool
    receipt: DeliveryReceipt = field(default_factory=DeliveryReceipt)
    consumed: bool = False


@dataclass
class HitResult:
    accepted: bool
    reason: str
    shooter: int
    target: int
    hp: int
    killed: bool = False
    update: GameUpdate = field(default_factory=GameUpdate)


class GameEngine:
    def __init__(self, clock: Callable[[], int] = monotonic_ms) -> None:
        self.clock = clock
        self.tanks = {tank_id: Tank(tank_id) for tank_id in TANK_IDS}
        self.phase = Phase.LOBBY
        self.deadline_ms: int | None = None
        self.winner: int | None = None
        self.round_id = 0
        self.next_shot = dict.fromkeys(TANK_IDS, 0)
        self.last_fire_ms: dict[int, int | None] = dict.fromkeys(TANK_IDS)
        self.shots: dict[tuple[int, int], Shot] = {}
        self.pending_fires: dict[int, Shot] = {}

    def enabled(self, tank_id: int) -> bool:
        if self.phase == Phase.LOBBY:
            return True
        return self.phase == Phase.RUNNING and self.tanks[tank_id].alive

    def _fresh_round(self) -> None:
        self.round_id += 1
        self.shots.clear()
        for tank in self.tanks.values():
            tank.alive = True
            tank.hp, tank.ammo = MAX_HP, MAX_AMMO
            tank.kills = tank.deaths = 0
            tank.respawn_at_ms = tank.next_ammo_ms = None
            tank.protected_until_ms = 0
            tank.life_id += 1
        # Preserve sequence numbers and real firing cooldowns across round boundaries.

    def start(self) -> GameUpdate:
        if self.phase != Phase.LOBBY:
            raise OperationError("A match can only be started from the lobby.")
        if any(not tank.online or tank.player is None for tank in self.tanks.values()):
            raise OperationError("Both tanks must be online and have a player.")
        self._fresh_round()
        self.phase = Phase.COUNTDOWN
        self.deadline_ms = self.clock() + COUNTDOWN_MS
        self.winner = None
        return GameUpdate(changed=True)

    def reset(self) -> GameUpdate:
        was_active = self.phase in (Phase.COUNTDOWN, Phase.RUNNING)
        self._fresh_round()
        self.phase = Phase.LOBBY
        self.deadline_ms = None
        self.winner = None
        events = [(tank_id, "game_end") for tank_id in TANK_IDS] if was_active else []
        return GameUpdate(changed=True, tank_events=events)

    def reserve_fire(self, shooter: int) -> Shot:
        """Reserve ammo before queuing the command; advance reconciles delivery receipts."""
        tank = self.tanks[shooter]
        now = self.clock()
        if not tank.online or not self.enabled(shooter):
            raise OperationError("Tank is offline or cannot fire in its current state.")
        if shooter in self.pending_fires:
            raise OperationError("The previous fire command is still being sent.")
        previous = self.last_fire_ms[shooter]
        if previous is not None and now - previous < FIRE_COOLDOWN_MS:
            raise OperationError("Weapon is cooling down.")
        charged = self.phase == Phase.RUNNING
        if charged and tank.ammo <= 0:
            raise OperationError("Out of ammunition.")
        shot_id = self.next_shot[shooter]
        record = Shot(shooter, shot_id, now, self.round_id, tank.life_id, charged)
        self.next_shot[shooter] = (shot_id + 1) % SHOT_COUNT
        self.last_fire_ms[shooter] = now
        self.shots[shooter, shot_id] = record
        self.pending_fires[shooter] = record
        if charged:
            tank.ammo -= 1
        return record

    def can_deliver(self, record: Shot) -> bool:
        return (
            not record.receipt.failed
            and record.receipt.sent_at_ms is None
            and record.round_id == self.round_id
            and record.life_id == self.tanks[record.shooter].life_id
            and self.enabled(record.shooter)
            and self.clock() - record.created_at_ms < FIRE_COOLDOWN_MS
        )

    def _reconcile_deliveries(self, update: GameUpdate, now: int) -> None:
        for shooter, record in tuple(self.pending_fires.items()):
            receipt = record.receipt
            if receipt.sent_at_ms is None and now - record.created_at_ms >= FIRE_COOLDOWN_MS:
                receipt.mark_failed()
            if receipt.failed:
                tank = self.tanks[shooter]
                if (
                    record.charged_ammo
                    and record.round_id == self.round_id
                    and record.life_id == tank.life_id
                    and tank.alive
                ):
                    tank.ammo = min(MAX_AMMO, tank.ammo + 1)
                    update.changed = True
                # Keep the reservation cooldown to prevent rapid reuse of four-bit IDs.
                if self.shots.get((shooter, record.shot)) is record:
                    del self.shots[shooter, record.shot]
                update.failed_fires.append(shooter)
                del self.pending_fires[shooter]
            elif receipt.sent_at_ms is not None:
                self.last_fire_ms[shooter] = receipt.sent_at_ms
                del self.pending_fires[shooter]

    def hit(self, target: int, shooter: int, shot_id: int) -> HitResult:
        now = self.clock()
        tank = self.tanks[target]
        record = self.shots.get((shooter, shot_id))
        reason = "accepted"
        if self.phase not in (Phase.LOBBY, Phase.RUNNING):
            reason = "wrong_phase"
        elif shooter == target:
            reason = "self_hit"
        elif record is None or record.round_id != self.round_id:
            reason = "unknown_shot"
        elif record.receipt.failed or record.receipt.sent_at_ms is None:
            reason = "not_delivered"
        elif not 0 <= now - record.receipt.sent_at_ms <= HIT_WINDOW_MS:
            reason = "expired_shot"
        elif record.consumed:
            reason = "duplicate_shot"
        elif not tank.alive:
            reason = "target_dead"
        elif now < tank.protected_until_ms:
            reason = "spawn_protected"
        result = HitResult(reason == "accepted", reason, shooter, target, tank.hp)
        if result.accepted:
            # Rejected hits leave the shot available for a later valid report.
            record.consumed = True
            if self.phase == Phase.RUNNING:
                tank.hp -= 1
                if tank.hp == 0:
                    tank.alive = False
                    tank.ammo = 0
                    tank.deaths += 1
                    tank.life_id += 1
                    tank.respawn_at_ms = now + RESPAWN_MS
                    tank.next_ammo_ms = None
                    tank.protected_until_ms = 0
                    self.tanks[shooter].kills += 1
                    result.killed = True
                    if self.tanks[shooter].kills >= WIN_KILLS:
                        self._finish(result.update)
            result.hp = tank.hp
            result.update.changed = True
        logger.info(
            "Hit %s: target=%s shooter=%s shot=%s hp=%s reason=%s",
            "accepted" if result.accepted else "rejected",
            target,
            shooter,
            shot_id,
            result.hp,
            result.reason,
        )
        return result

    def advance(self) -> GameUpdate:
        now = self.clock()
        update = GameUpdate()
        self._reconcile_deliveries(update, now)
        if self.phase == Phase.COUNTDOWN and now >= self.deadline_ms:
            self.phase = Phase.RUNNING
            self.deadline_ms += MATCH_MS
            for tank in self.tanks.values():
                tank.next_ammo_ms = self.deadline_ms - MATCH_MS + AMMO_REFILL_MS
            update.changed = True
            update.tank_events.extend((tank_id, "game_start") for tank_id in TANK_IDS)
        if self.phase == Phase.RUNNING:
            if now >= self.deadline_ms or any(t.kills >= WIN_KILLS for t in self.tanks.values()):
                self._finish(update)
            else:
                self._advance_lives(update, now)
        return update

    def _advance_lives(self, update: GameUpdate, now: int) -> None:
        for tank in self.tanks.values():
            if not tank.alive and tank.respawn_at_ms is not None and now >= tank.respawn_at_ms:
                tank.alive = True
                tank.hp, tank.ammo = MAX_HP, MAX_AMMO
                tank.life_id += 1
                tank.respawn_at_ms = None
                # A late scheduler must still grant a full protection interval.
                tank.protected_until_ms = now + SPAWN_PROTECTION_MS
                tank.next_ammo_ms = now + AMMO_REFILL_MS
                update.changed = True
                update.tank_events.append((tank.id, "respawn"))
            if tank.alive and tank.next_ammo_ms is not None and now >= tank.next_ammo_ms:
                amount = (now - tank.next_ammo_ms) // AMMO_REFILL_MS + 1
                previous = tank.ammo
                tank.ammo = min(MAX_AMMO, tank.ammo + amount)
                tank.next_ammo_ms += amount * AMMO_REFILL_MS
                update.changed |= tank.ammo != previous

    def _finish(self, update: GameUpdate) -> None:
        first, second = (self.tanks[tank_id] for tank_id in TANK_IDS)
        self.winner = None
        if first.kills != second.kills:
            self.winner = first.id if first.kills > second.kills else second.id
        self.phase = Phase.ENDED
        self.deadline_ms = None
        self.shots.clear()
        for tank in self.tanks.values():
            tank.respawn_at_ms = tank.next_ammo_ms = None
            tank.protected_until_ms = 0
        update.changed = True
        update.tank_events.extend((tank_id, "game_end") for tank_id in TANK_IDS)

    def snapshot(self) -> WebState:
        now = self.clock()
        remaining = max(0, self.deadline_ms - now) if self.deadline_ms is not None else 0
        tanks = [
            TankSnapshot(
                id=tank.id,
                player=tank.player,
                online=tank.online,
                alive=tank.alive,
                hp=tank.hp,
                ammo=tank.ammo,
                kills=tank.kills,
                deaths=tank.deaths,
                respawn_ms=max(0, tank.respawn_at_ms - now)
                if tank.respawn_at_ms is not None
                else 0,
            )
            for tank in self.tanks.values()
        ]
        return WebState(
            status=self.phase.value, time_left_ms=remaining, winner=self.winner, tanks=tanks
        )
