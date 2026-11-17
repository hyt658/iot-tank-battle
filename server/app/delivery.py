"""Local delivery metadata; these fields are never included in protocol messages."""

from dataclasses import dataclass


@dataclass
class DeliveryReceipt:
    sent_at_ms: int | None = None
    failed: bool = False

    def mark_sent(self, now: int) -> None:
        if not self.failed:
            self.sent_at_ms = now

    def mark_failed(self) -> None:
        if self.sent_at_ms is None:
            self.failed = True
