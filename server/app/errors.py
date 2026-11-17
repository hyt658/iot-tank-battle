"""Expected operation and protocol errors."""


class OperationError(Exception):
    """An error that can be sent using the protocol's error message."""


class ProtocolError(OperationError):
    """The incoming message does not match the client's role or schema."""

    def __init__(self, message: str, *, message_type: str | None = None) -> None:
        super().__init__(message)
        self.message_type = message_type
