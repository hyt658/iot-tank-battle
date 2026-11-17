"""Explicit placeholders for rules that require the project owner's decision."""

from app.errors import DecisionRequired
from app.protocol import Role


def reset_match() -> None:
    # TODO: Confirm player bindings, HP/ammo restoration, and reset event semantics.
    raise DecisionRequired("reset 尚待确认：连接和玩家是否保留、HP/弹药如何恢复、是否发送 game_end")


def active_match_disconnect(role: Role, tank_id: int) -> None:
    # TODO: Implement the confirmed continuation, pause, or termination policy.
    raise DecisionRequired(
        f"比赛中 {role.value} {tank_id} 断线的规则尚待确认；状态机自动推进暂未实现"
    )
