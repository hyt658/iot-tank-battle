"""Serialize arena changes and coordinate registration, heartbeats, and lifecycle output."""

import asyncio
import logging
from collections.abc import Callable
from contextlib import suppress

from fastapi import WebSocket, WebSocketDisconnect

from app.config import Settings
from app.connections import Connection
from app.constants import (
    CONNECTION_TIMEOUT_MS,
    PING_INTERVAL_MS,
    REPLACED_CONNECTION_CLOSE_CODE,
    WEB_STATE_INTERVAL_MS,
)
from app.errors import OperationError, ProtocolError
from app.game import GameEngine, GameUpdate, Phase, monotonic_ms
from app.protocol import (
    Drive,
    Error,
    Fire,
    GameCommand,
    Hit,
    HitEvent,
    KillEvent,
    Message,
    Pong,
    Role,
    TankEvent,
    TankEventType,
    TankFire,
    TankState,
    parse_message,
)

logger = logging.getLogger(__name__)


class Arena:
    def __init__(self, settings: Settings, clock: Callable[[], int] = monotonic_ms) -> None:
        self.settings = settings
        self.clock = clock
        self.game = GameEngine(clock)
        self.lock = asyncio.Lock()
        self.connections: set[Connection] = set()
        self.tanks: dict[int, Connection] = {}
        self.players: dict[int, Connection] = {}
        self.next_web_state_ms = clock() + WEB_STATE_INTERVAL_MS
        self._scheduler: asyncio.Task | None = None
        self._stopping = False
        self._fire_owners: dict[int, Connection] = {}

    async def start(self) -> None:
        self._scheduler = asyncio.create_task(self._run_scheduler(), name="arena-scheduler")

    async def stop(self) -> None:
        self._stopping = True
        if self._scheduler is not None:
            self._scheduler.cancel()
            with suppress(asyncio.CancelledError):
                await self._scheduler
        async with self.lock:
            for connection in tuple(self.connections):
                connection.request_close(1001, "Server shutting down")

    async def serve(
        self,
        websocket: WebSocket,
        role: Role,
        *,
        tank_id: int | None = None,
        player_name: str | None = None,
    ) -> None:
        await websocket.accept()
        connection = Connection(
            websocket, role, self.clock(), self.settings.runtime, clock=self.clock, tank_id=tank_id
        )
        async with self.lock:
            self._advance()
            self._register(connection, player_name)
        writer = asyncio.create_task(connection.write(), name=f"{role.value}-writer")
        reader = asyncio.create_task(self._read(connection), name=f"{role.value}-reader")
        try:
            done, _ = await asyncio.wait((reader, writer), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        except (WebSocketDisconnect, OSError):
            pass
        finally:
            async with self.lock:
                self._detach(connection)
            connection.request_close(1001, "Connection closed")
            try:
                async with asyncio.timeout(self.settings.runtime.send_timeout_seconds * 3):
                    await asyncio.shield(writer)
            except (TimeoutError, asyncio.CancelledError):
                pass
            finally:
                reader.cancel()
                writer.cancel()
                await asyncio.gather(reader, writer, return_exceptions=True)

    async def _read(self, connection: Connection) -> None:
        while not connection.closing:
            incoming = await connection.websocket.receive()
            if incoming["type"] == "websocket.disconnect":
                return
            received_at = self.clock()
            async with self.lock:
                # Any incoming message counts as activity, not only a pong.
                if connection.closing:
                    return
                connection.last_received_ms = received_at
                try:
                    text = incoming.get("text")
                    if text is None:
                        raise ProtocolError("Only JSON text messages are accepted.")
                    message = parse_message(connection.role, text)
                    if message is None:
                        continue
                    self._advance()
                    self._dispatch(connection, message)
                except OperationError as exc:
                    if isinstance(exc, ProtocolError) and exc.message_type == "hit":
                        logger.info(
                            "Hit rejected: target=%s reason=invalid_message detail=%s",
                            connection.tank_id,
                            exc,
                        )
                    connection.send(Error(message=str(exc)))

    def _register(self, connection: Connection, player_name: str | None = None) -> None:
        self.connections.add(connection)
        if connection.role == Role.CONTROL:
            connection.send(self.game.snapshot())
            return

        tank_id = connection.tank_id
        assert tank_id is not None
        is_tank = connection.role == Role.TANK
        slots = self.tanks if is_tank else self.players
        previous = slots.get(tank_id)
        slots[tank_id] = connection
        if previous is not None:
            previous.request_close(
                REPLACED_CONNECTION_CLOSE_CODE, "Replaced by a new connection for this address."
            )
            self.connections.discard(previous)
            if not is_tank and tank_id in self.tanks:
                self.tanks[tank_id].cancel_controls()

        tank = self.game.tanks[tank_id]
        if is_tank:
            tank.online = True
            self._sync_tank_states()
        else:
            tank.player = player_name
        self._broadcast_web_state()

    def _dispatch(self, connection: Connection, message: Message) -> None:
        if isinstance(message, Pong):
            if message.ts not in connection.pending_pings:
                raise ProtocolError("pong must echo the original server ts value.")
            connection.pending_pings.remove(message.ts)
            logger.info(
                "Heartbeat RTT: connection=%x role=%s tank_id=%s rtt_ms=%d",
                id(connection),
                connection.role.value,
                connection.tank_id,
                connection.last_received_ms - message.ts,
            )
            return
        if isinstance(message, GameCommand):
            update = self.game.start() if message.type == "start" else self.game.reset()
            for client in self.connections:
                client.discard_game_output()
            for tank in self.tanks.values():
                tank.cancel_controls()
            self._fire_owners.clear()
            self._publish_change(update)
            return
        tank_id = connection.tank_id
        assert tank_id is not None
        if isinstance(message, Drive):
            if not self.game.enabled(tank_id):
                return
            tank = self._available_tank(tank_id)
            if tank is not None:
                tank.send_drive(message)
        elif isinstance(message, Fire):
            tank = self._available_tank(tank_id)
            if tank is None:
                raise OperationError("Tank is offline.")
            record = self.game.reserve_fire(tank_id)
            self._fire_owners[record.shooter] = connection
            tank.send(
                TankFire(type="fire", shot=record.shot),
                receipt=record.receipt,
                is_valid=lambda: (
                    self.tanks.get(record.shooter) is tank and self.game.can_deliver(record)
                ),
            )
            self._advance()
            if record.charged_ammo:
                self._broadcast_web_state()
        elif isinstance(message, Hit):
            self._handle_hit(tank_id, message)

    def _available_tank(self, tank_id: int) -> Connection | None:
        tank = self.tanks.get(tank_id)
        if tank is not None and (
            tank.closing or self.clock() - tank.last_received_ms >= CONNECTION_TIMEOUT_MS
        ):
            tank.request_close(1001, "Receive timeout")
            self._detach(tank)
            return None
        return tank

    def _handle_hit(self, target: int, message: Hit) -> None:
        result = self.game.hit(target, message.shooter, message.shot)
        if not result.accepted:
            return
        self._send_tank_event(target, "death" if result.killed else "hurt")
        event_type = KillEvent if result.killed else HitEvent
        event = event_type(shooter=message.shooter, target=target)
        round_id = self.game.round_id
        for client in self.connections:
            if client.role != Role.TANK:
                client.send(event, is_valid=lambda: self.game.round_id == round_id)
        self._publish_change(result.update)

    def _detach(self, connection: Connection) -> None:
        self.connections.discard(connection)
        changed = False
        tank_id = connection.tank_id
        if connection.role == Role.TANK and self.tanks.get(tank_id) is connection:
            del self.tanks[tank_id]
            self.game.tanks[tank_id].online = False
            changed = True
        elif connection.role == Role.PLAYER and self.players.get(tank_id) is connection:
            del self.players[tank_id]
            self.game.tanks[tank_id].player = None
            tank = self.tanks.get(tank_id)
            if tank is not None:
                tank.cancel_controls(drive_only=True)
            changed = True
        if changed and not self._stopping:
            self._broadcast_web_state()

    def _advance(self) -> None:
        self._publish_change(self.game.advance())
        for tank_id in tuple(self._fire_owners):
            if tank_id not in self.game.pending_fires:
                del self._fire_owners[tank_id]

    def _send_tank_event(self, tank_id: int, event_type: TankEventType) -> None:
        connection = self.tanks.get(tank_id)
        if connection is None:
            return
        round_id = self.game.round_id
        life_id = self.game.tanks[tank_id].life_id

        def is_current() -> bool:
            if self.game.round_id != round_id:
                return False
            tank = self.game.tanks[tank_id]
            if tank.life_id != life_id:
                return False
            if event_type == "death":
                return not tank.alive and self.game.phase in (Phase.RUNNING, Phase.ENDED)
            return tank.alive and self.game.phase in (Phase.LOBBY, Phase.RUNNING)

        connection.send(TankEvent(type=event_type), is_valid=is_current)

    def _sync_tank_states(self) -> None:
        for tank_id, connection in self.tanks.items():
            enabled = self.game.enabled(tank_id)
            if enabled != connection.last_enable:
                if connection.send(TankState(enable=enabled)):
                    connection.last_enable = enabled

    def _broadcast_web_state(self) -> None:
        snapshot = self.game.snapshot()
        for connection in self.connections:
            if connection.role != Role.TANK:
                connection.send(snapshot)

    def _publish_change(self, update: GameUpdate) -> None:
        self._sync_tank_states()
        for tank_id in update.respawned:
            self._send_tank_event(tank_id, "respawn")
        for tank_id in update.failed_fires:
            connection = self._fire_owners.pop(tank_id, None)
            if connection is not None and self.players.get(tank_id) is connection:
                connection.send(Error(message="Fire command failed or expired. Please try again."))
        if update.changed:
            self._broadcast_web_state()

    async def poll(self) -> None:
        async with self.lock:
            now = self.clock()
            for connection in tuple(self.connections):
                if connection.closing:
                    self._detach(connection)
                    continue
                if now - connection.last_received_ms >= CONNECTION_TIMEOUT_MS:
                    connection.request_close(1001, "Receive timeout")
                    self._detach(connection)
                elif now >= connection.next_ping_ms:
                    missed = (now - connection.next_ping_ms) // PING_INTERVAL_MS + 1
                    connection.next_ping_ms += missed * PING_INTERVAL_MS
                    connection.send_ping()
            self._advance()
            if now >= self.next_web_state_ms:
                self._broadcast_web_state()
                missed = (now - self.next_web_state_ms) // WEB_STATE_INTERVAL_MS + 1
                self.next_web_state_ms += missed * WEB_STATE_INTERVAL_MS

    async def _run_scheduler(self) -> None:
        while True:
            await asyncio.sleep(self.settings.runtime.tick_interval_ms / 1000)
            await self.poll()
