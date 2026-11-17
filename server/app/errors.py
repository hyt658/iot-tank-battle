"""Expected protocol, feature, and unresolved-policy errors."""


class OperationError(Exception):
    """An error that can be sent using the protocol's error message."""


class ProtocolError(OperationError):
    """The incoming message does not match the client's role or schema."""


class DecisionRequired(OperationError):
    """The protocol needs clarification before this operation can be implemented."""


class FeatureNotImplemented(OperationError):
    """The message belongs to a later development milestone."""
