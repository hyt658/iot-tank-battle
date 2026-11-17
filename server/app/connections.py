"""Per-connection output queues with a single, bounded-time WebSocket writer."""

import asyncio
import logging
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.config import RuntimeSettings
from app.constants import PING_INTERVAL_MS
from app.protocol import Error, Message, Role, as_payload

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CloseFrame:
    code: int
    reason: str


class Connection:
    def __init__(
        self, websocket: WebSocket, role: Role, now: int, settings: RuntimeSettings
    ) -> None:
        self.websocket = websocket
        self.role = role
        self.settings = settings
        self.tank_id: int | None = None
        self.registered = False
        self.closing = False
        self.last_received_ms = now
        self.next_ping_ms = now + PING_INTERVAL_MS
        self.pending_pings: deque[int] = deque(maxlen=4)
        self.last_enable: bool | None = None
        self.outbox: asyncio.Queue[dict[str, Any] | CloseFrame] = asyncio.Queue(
            maxsize=settings.outbound_queue_size
        )

    def send(self, message: Message) -> bool:
        if self.closing:
            return False
        try:
            self.outbox.put_nowait(as_payload(message))
        except asyncio.QueueFull:
            logger.warning("Closing slow %s connection: output queue full", self.role.value)
            self.request_close(1013, "Output queue full")
            return False
        return True

    def request_close(self, code: int, reason: str, error: str | None = None) -> None:
        if self.closing:
            return
        self.closing = True
        # A terminal error and close must not wait behind obsolete snapshots.
        while not self.outbox.empty():
            self.outbox.get_nowait()
        if error is not None:
            self.outbox.put_nowait(as_payload(Error(message=error)))
        self.outbox.put_nowait(CloseFrame(code, reason))

    async def write(self) -> None:
        try:
            while True:
                item = await self.outbox.get()
                async with asyncio.timeout(self.settings.send_timeout_seconds):
                    if isinstance(item, CloseFrame):
                        await self.websocket.close(code=item.code, reason=item.reason)
                        return
                    await self.websocket.send_json(item)
        except (OSError, RuntimeError, WebSocketDisconnect, TimeoutError):
            logger.debug("WebSocket writer stopped", exc_info=True)
            with suppress(OSError, RuntimeError, WebSocketDisconnect, TimeoutError):
                async with asyncio.timeout(self.settings.send_timeout_seconds):
                    await self.websocket.close(code=1011, reason="Send failed")
        finally:
            self.closing = True
