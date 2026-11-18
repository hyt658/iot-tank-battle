"""Isolated output queues with bounded control age and delivery receipts."""

import asyncio
import logging
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.config import RuntimeSettings
from app.constants import DRIVE_TIMEOUT_MS, PING_INTERVAL_MS
from app.delivery import DeliveryReceipt
from app.game import monotonic_ms
from app.protocol import Drive, Error, Message, Ping, Role, TankState, WebState, as_payload

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CloseFrame:
    code: int
    reason: str


@dataclass
class Packet:
    payload: dict[str, Any]
    receipt: DeliveryReceipt | None = None
    is_valid: Callable[[], bool] | None = None

    def discard(self) -> None:
        if self.receipt is not None:
            self.receipt.mark_failed()


@dataclass(frozen=True)
class DriveSlot:
    generation: int


class Connection:
    def __init__(
        self,
        websocket: WebSocket,
        role: Role,
        now: int,
        settings: RuntimeSettings,
        *,
        clock: Callable[[], int] = monotonic_ms,
    ) -> None:
        self.websocket = websocket
        self.role = role
        self.settings = settings
        self.clock = clock
        self.tank_id: int | None = None
        self.registered = False
        self.closing = False
        self.last_received_ms = now
        self.next_ping_ms = now + PING_INTERVAL_MS
        self.pending_pings: deque[int] = deque(maxlen=4)
        self.last_enable: bool | None = None
        self.outbox: asyncio.Queue[Packet | CloseFrame | DriveSlot] = asyncio.Queue(
            maxsize=settings.outbound_queue_size
        )
        self._drive_generation = 0
        self._drive_queued = False
        self._latest_drive: tuple[Drive, int] | None = None
        self._pending_state: Packet | None = None

    def _enqueue(self, item: Packet | DriveSlot) -> bool:
        if not self.closing:
            try:
                self.outbox.put_nowait(item)
                return True
            except asyncio.QueueFull:
                logger.warning("Closing slow %s connection: output queue full", self.role.value)
                self.request_close(1013, "Output queue full")
        if isinstance(item, Packet):
            item.discard()
        return False

    def send(
        self,
        message: Message,
        *,
        receipt: DeliveryReceipt | None = None,
        is_valid: Callable[[], bool] | None = None,
    ) -> bool:
        if isinstance(message, TankState) and not message.enable:
            self.cancel_controls()
        packet = Packet(as_payload(message), receipt, is_valid)
        if isinstance(message, (TankState, WebState)) and not self.closing:
            if self._pending_state is not None:
                # Replace only within the same event interval, preserving causal order.
                self._pending_state.payload = packet.payload
                self._pending_state.is_valid = is_valid
                return True
            self._pending_state = packet
        elif not isinstance(message, Ping):
            self._pending_state = None
        return self._enqueue(packet)

    def discard_game_output(self) -> None:
        """Drop unsent snapshots and events at an explicit round boundary."""
        self._pending_state = None
        retained = []
        while not self.outbox.empty():
            item = self.outbox.get_nowait()
            if isinstance(item, Packet) and item.payload["type"] in ("state", "event"):
                if "enable" in item.payload:
                    self.last_enable = None
                item.discard()
            else:
                retained.append(item)
        for item in retained:
            self.outbox.put_nowait(item)

    def send_drive(self, message: Drive) -> bool:
        if self.closing:
            return False
        self._latest_drive = (message, self.clock())
        if not self._drive_queued:
            self._drive_queued = True
            return self._enqueue(DriveSlot(self._drive_generation))
        return True

    def cancel_controls(self, *, drive_only: bool = False) -> None:
        self._drive_generation += 1
        self._drive_queued = False
        self._latest_drive = None
        retained = []
        while not self.outbox.empty():
            item = self.outbox.get_nowait()
            if isinstance(item, DriveSlot):
                continue
            if isinstance(item, Packet) and item.receipt is not None and not drive_only:
                item.discard()
            else:
                retained.append(item)
        for item in retained:
            self.outbox.put_nowait(item)

    def request_close(self, code: int, reason: str, error: str | None = None) -> None:
        if self.closing:
            return
        self.closing = True
        self._discard_queued()
        if error is not None:
            self.outbox.put_nowait(Packet(as_payload(Error(message=error))))
        self.outbox.put_nowait(CloseFrame(code, reason))

    def _discard_queued(self) -> None:
        self._pending_state = None
        self._latest_drive = None
        self._drive_queued = False
        while not self.outbox.empty():
            item = self.outbox.get_nowait()
            if isinstance(item, Packet):
                item.discard()

    def _take_drive(self, slot: DriveSlot) -> Packet | None:
        if slot.generation != self._drive_generation or self._latest_drive is None:
            return None
        message, received_at = self._latest_drive
        self._latest_drive = None
        self._drive_queued = False
        if self.clock() - received_at >= DRIVE_TIMEOUT_MS:
            return None
        return Packet(as_payload(message))

    async def write(self) -> None:
        active: Packet | None = None
        try:
            while True:
                item = await self.outbox.get()
                if item is self._pending_state:
                    self._pending_state = None
                if isinstance(item, DriveSlot):
                    item = self._take_drive(item)
                    if item is None:
                        continue
                if isinstance(item, Packet) and item.is_valid is not None and not item.is_valid():
                    item.discard()
                    continue
                active = item if isinstance(item, Packet) else None
                async with asyncio.timeout(self.settings.send_timeout_seconds):
                    if isinstance(item, CloseFrame):
                        await self.websocket.close(code=item.code, reason=item.reason)
                        return
                    await self.websocket.send_json(item.payload)
                    if item.receipt is not None:
                        item.receipt.mark_sent(self.clock())
                active = None
        except (OSError, RuntimeError, WebSocketDisconnect, TimeoutError):
            logger.debug("WebSocket writer stopped", exc_info=True)
            with suppress(OSError, RuntimeError, WebSocketDisconnect, TimeoutError):
                async with asyncio.timeout(self.settings.send_timeout_seconds):
                    await self.websocket.close(code=1011, reason="Send failed")
        finally:
            if active is not None:
                active.discard()
            self._discard_queued()
            self.closing = True
