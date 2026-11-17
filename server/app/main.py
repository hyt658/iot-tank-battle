"""FastAPI application factory and the three protocol WebSocket routes."""

from collections.abc import Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket

from app.arena import Arena
from app.config import Settings, load_settings
from app.game import monotonic_ms
from app.protocol import Role


def create_app(
    settings: Settings | None = None, clock: Callable[[], int] = monotonic_ms
) -> FastAPI:
    arena = Arena(settings or load_settings(), clock)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        await arena.start()
        try:
            yield
        finally:
            await arena.stop()

    application = FastAPI(
        title="IoT Tank Battle", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None
    )
    application.state.arena = arena

    @application.websocket("/ws/tank")
    async def tank_socket(websocket: WebSocket) -> None:
        await arena.serve(websocket, Role.TANK)

    @application.websocket("/ws/player")
    async def player_socket(websocket: WebSocket) -> None:
        await arena.serve(websocket, Role.PLAYER)

    @application.websocket("/ws/spectator")
    async def spectator_socket(websocket: WebSocket) -> None:
        await arena.serve(websocket, Role.SPECTATOR)

    return application


app = create_app()
