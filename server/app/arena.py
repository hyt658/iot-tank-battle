"""Serialize arena changes and coordinate registration, heartbeats, and lifecycle output."""

import asyncio
import logging
from collections.abc import Callable
from contextlib import suppress

from fastapi import WebSocket, WebSocketDisconnect

from app.config import Settings
from app.connections import Connection
from app.constants import CONNECTION_TIMEOUT_MS, PING_INTERVAL_MS, WEB_STATE_INTERVAL_MS
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
    Ping,
    PlayerHello,
    Pong,
    Role,
    SpectatorHello,
    TankEvent,
    TankFire,
    TankHello,
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

    async def serve(self, websocket: WebSocket, role: Role) -> None:
        await websocket.accept()
        connection = Connection(
            websocket, role, self.clock(), self.settings.runtime, clock=self.clock
        )
        async with self.lock:
            self.connections.add(connection)
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
            async with self.lock:
                # Any incoming message counts as activity, not only a pong.
                connection.last_received_ms = self.clock()
                if connection.closing:
                    return
                try:
                    if incoming.get("text") is None:
                        raise ProtocolError("Only JSON text messages are accepted.")
                    message = parse_message(
                        connection.role, incoming["text"], registered=connection.registered
                    )
                    self._advance()
                    if not connection.registered:
                        self._register(connection, message)
                    else:
                        self._dispatch(connection, message)
                except OperationError as exc:
                    if isinstance(exc, ProtocolError) and exc.message_type == "hit":
                        logger.info(
                            "Hit rejected: target=%s reason=invalid_message detail=%s",
                            connection.tank_id,
                            exc,
                        )
                    if connection.registered:
                        connection.send(Error(message=str(exc)))
                    else:
                        connection.request_close(1008, "Hello rejected", error=str(exc))

    def _register(self, connection: Connection, message: Message) -> None:
        if isinstance(message, PlayerHello):
            if message.tank_id in self.players:
                raise OperationError("This tank is already controlled by another player.")
            connection.tank_id = message.tank_id
            self.players[message.tank_id] = connection
            self.game.tanks[message.tank_id].player = message.name
        elif isinstance(message, TankHello):
            previous = self.tanks.get(message.tank_id)
            if previous is not None:
                previous.request_close(1000, "Replaced by a new tank connection")
                previous.registered = False
                self.connections.discard(previous)
            connection.tank_id = message.tank_id
            self.tanks[message.tank_id] = connection
            self.game.tanks[message.tank_id].online = True
        elif not isinstance(message, SpectatorHello):
            raise ProtocolError("The first message after connecting must be hello.")
        connection.registered = True
        if connection.role == Role.TANK:
            self._sync_tank_states()
        if connection.role == Role.SPECTATOR:
            connection.send(self.game.snapshot())
        else:
            self._broadcast_web_state()

    def _dispatch(self, connection: Connection, message: Message) -> None:
        if isinstance(message, Pong):
            if message.ts not in connection.pending_pings:
                raise ProtocolError("pong must echo the original server ts value.")
            connection.pending_pings.remove(message.ts)
        elif isinstance(message, GameCommand):
            if message.action == "start":
                update = self.game.start()
            else:
                update = self.game.reset()
            for client in self.connections:
                client.discard_game_output()
            for tank in self.tanks.values():
                tank.cancel_controls()
            self._fire_owners.clear()
            self._publish_change(update)
        elif isinstance(message, Drive):
            if not self.game.enabled(connection.tank_id):
                return
            tank = self._available_tank(connection.tank_id)
            if tank is not None:
                tank.send_drive(message)
        elif isinstance(message, Fire):
            tank = self._available_tank(connection.tank_id)
            if tank is None:
                raise OperationError("Tank is offline.")
            record = self.game.reserve_fire(connection.tank_id)
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
            self._handle_hit(connection, message)

    def _available_tank(self, tank_id: int) -> Connection | None:
        tank = self.tanks.get(tank_id)
        if tank is not None and (
            tank.closing or self.clock() - tank.last_received_ms >= CONNECTION_TIMEOUT_MS
        ):
            tank.request_close(1001, "Receive timeout")
            self._detach(tank)
            return None
        return tank

    def _handle_hit(self, connection: Connection, message: Hit) -> None:
        result = self.game.hit(connection.tank_id, message.shooter, message.shot)
        if not result.accepted:
            return
        self._send_tank_event(connection.tank_id, "death" if result.killed else "hurt")
        if result.killed:
            self._sync_tank_states()
        self._send_tank_event(message.shooter, "hit_confirm")
        if result.killed:
            event = KillEvent(shooter=message.shooter, target=connection.tank_id)
        else:
            event = HitEvent(shooter=message.shooter, target=connection.tank_id, hp=result.hp)
        round_id = self.game.round_id
        for client in self.connections:
            if client.registered and client.role != Role.TANK:
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
        connection.registered = False
        if changed and not self._stopping:
            self._broadcast_web_state()

    def _advance(self) -> None:
        self._publish_change(self.game.advance())
        for tank_id in tuple(self._fire_owners):
            if tank_id not in self.game.pending_fires:
                del self._fire_owners[tank_id]

    def _send_tank_event(self, tank_id: int, kind: str) -> None:
        connection = self.tanks.get(tank_id)
        if connection is None:
            return
        round_id = self.game.round_id
        life_id = self.game.tanks[tank_id].life_id

        def is_current() -> bool:
            if self.game.round_id != round_id:
                return False
            if kind == "game_start":
                return self.game.phase == Phase.RUNNING
            if kind in ("game_end", "hit_confirm"):
                return True
            tank = self.game.tanks[tank_id]
            if tank.life_id != life_id:
                return False
            if kind == "death":
                return not tank.alive and self.game.phase in (Phase.RUNNING, Phase.ENDED)
            return tank.alive and self.game.phase in (Phase.LOBBY, Phase.RUNNING)

        connection.send(TankEvent(kind=kind), is_valid=is_current)

    def _sync_tank_states(self) -> None:
        for tank_id, connection in self.tanks.items():
            enabled = self.game.enabled(tank_id)
            if enabled != connection.last_enable:
                if connection.send(TankState(enable=enabled)):
                    connection.last_enable = enabled

    def _broadcast_web_state(self) -> None:
        snapshot = self.game.snapshot()
        for connection in self.connections:
            if connection.registered and connection.role != Role.TANK:
                connection.send(snapshot)

    def _publish_change(self, update: GameUpdate) -> None:
        self._sync_tank_states()
        for tank_id, kind in update.tank_events:
            self._send_tank_event(tank_id, kind)
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
                    error = None if connection.registered else "No hello received within 3 seconds."
                    connection.request_close(1001, "Receive timeout", error=error)
                    self._detach(connection)
                elif now >= connection.next_ping_ms:
                    connection.pending_pings.append(now)
                    connection.next_ping_ms = now + PING_INTERVAL_MS
                    connection.send(Ping(ts=now))
            self._advance()
            if now >= self.next_web_state_ms:
                self._broadcast_web_state()
                missed = (now - self.next_web_state_ms) // WEB_STATE_INTERVAL_MS + 1
                self.next_web_state_ms += missed * WEB_STATE_INTERVAL_MS

    async def _run_scheduler(self) -> None:
        while True:
            await asyncio.sleep(self.settings.runtime.tick_interval_ms / 1000)
            await self.poll()
