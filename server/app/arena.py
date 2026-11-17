"""Serialize arena changes and coordinate registration, heartbeats, and lifecycle output."""

import asyncio
import logging
from collections.abc import Callable
from contextlib import suppress

from fastapi import WebSocket, WebSocketDisconnect

from app.config import Settings
from app.connections import Connection
from app.constants import CONNECTION_TIMEOUT_MS, PING_INTERVAL_MS, WEB_STATE_INTERVAL_MS
from app.errors import DecisionRequired, FeatureNotImplemented, OperationError, ProtocolError
from app.game import GameEngine, monotonic_ms
from app.protocol import (
    Drive,
    Error,
    Fire,
    GameCommand,
    Hit,
    Message,
    Ping,
    PlayerHello,
    Pong,
    Role,
    SpectatorHello,
    TankEvent,
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
        self._announced_decisions: set[str] = set()

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
        connection = Connection(websocket, role, self.clock(), self.settings.runtime)
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
                        raise ProtocolError("协议只接受 JSON 文本消息")
                    message = parse_message(
                        connection.role, incoming["text"], registered=connection.registered
                    )
                    self._advance()
                    if not connection.registered:
                        self._register(connection, message)
                    else:
                        self._dispatch(connection, message)
                except OperationError as exc:
                    if connection.registered:
                        connection.send(Error(message=str(exc)))
                    else:
                        connection.request_close(1008, "Hello rejected", error=str(exc))

    def _register(self, connection: Connection, message: Message) -> None:
        if isinstance(message, PlayerHello):
            if message.tank_id in self.players:
                raise OperationError("这台坦克已经有人控制")
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
            raise ProtocolError("连接后的第一条消息必须是 hello")
        connection.registered = True
        if connection.role == Role.TANK:
            self._sync_tank_states()
        if connection.role == Role.SPECTATOR:
            connection.send(self.game.snapshot())
        else:
            self._broadcast_web_state()
        if self.game.pending_decision is not None:
            connection.send(Error(message=self.game.pending_decision))

    def _dispatch(self, connection: Connection, message: Message) -> None:
        if isinstance(message, Pong):
            if message.ts not in connection.pending_pings:
                raise ProtocolError("pong 的 ts 必须原样返回服务器发送的值")
            connection.pending_pings.remove(message.ts)
        elif isinstance(message, GameCommand):
            if message.action == "start":
                self.game.start()
                self._publish_change([])
            else:
                self.game.reset()
        elif isinstance(message, Drive):
            if not self.game.enabled(connection.tank_id):
                return
            raise FeatureNotImplemented("驾驶转发尚未实现，属于开发计划第 4 步")
        elif isinstance(message, Fire):
            raise FeatureNotImplemented("开火许可尚未实现，属于开发计划第 4 步")
        elif isinstance(message, Hit):
            logger.info(
                "Hit rejected: target=%s shooter=%s shot=%s reason=not_implemented",
                connection.tank_id,
                message.shooter,
                message.shot,
            )
            raise FeatureNotImplemented("命中判定尚未实现，属于开发计划第 5 步")

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
            changed = True
        connection.registered = False
        if changed and not self._stopping:
            try:
                self.game.note_disconnect(connection.role, tank_id)
            except DecisionRequired as exc:
                self._announce_decision(str(exc))
            self._broadcast_web_state()

    def _announce_decision(self, message: str) -> None:
        if message in self._announced_decisions:
            return
        self._announced_decisions.add(message)
        logger.warning("Unresolved match policy: %s", message)
        for connection in self.connections:
            if connection.registered:
                connection.send(Error(message=message))

    def _advance(self) -> None:
        if self.game.pending_decision is not None:
            return
        events = self.game.advance()
        if events:
            self._publish_change(events)

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

    def _publish_change(self, events: list[str]) -> None:
        self._sync_tank_states()
        for kind in events:
            for connection in self.tanks.values():
                connection.send(TankEvent(kind=kind))
        self._broadcast_web_state()

    async def poll(self) -> None:
        async with self.lock:
            now = self.clock()
            for connection in tuple(self.connections):
                if connection.closing:
                    self._detach(connection)
                    continue
                if now - connection.last_received_ms >= CONNECTION_TIMEOUT_MS:
                    error = None if connection.registered else "3 秒内未收到 hello"
                    connection.request_close(1001, "Receive timeout", error=error)
                    self._detach(connection)
                elif now >= connection.next_ping_ms:
                    connection.pending_pings.append(now)
                    connection.next_ping_ms = now + PING_INTERVAL_MS
                    connection.send(Ping(ts=now))
            self._advance()
            if now >= self.next_web_state_ms:
                self._broadcast_web_state()
                self.next_web_state_ms = now + WEB_STATE_INTERVAL_MS

    async def _run_scheduler(self) -> None:
        while True:
            await asyncio.sleep(self.settings.runtime.tick_interval_ms / 1000)
            await self.poll()
