"""FastAPI application factory, URL registration, and frontend hosting."""

from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket

from app.arena import Arena
from app.config import Settings, load_settings
from app.constants import INVALID_ADDRESS_CLOSE_CODE, TANK_IDS
from app.frontend import FrontendFiles
from app.game import monotonic_ms
from app.protocol import Role

DEFAULT_WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
TANK_IDS_BY_PATH = {str(tank_id): tank_id for tank_id in TANK_IDS}


async def reject_address(websocket: WebSocket, reason: str) -> None:
    # Accept the upgrade so the client receives a WebSocket close frame.
    await websocket.accept()
    await websocket.close(code=INVALID_ADDRESS_CLOSE_CODE, reason=reason)


def create_app(
    settings: Settings | None = None,
    clock: Callable[[], int] = monotonic_ms,
    *,
    web_dist: Path = DEFAULT_WEB_DIST,
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

    @application.websocket("/ws/tank/{tank_id}")
    async def tank_socket(websocket: WebSocket, tank_id: str) -> None:
        tank_number = TANK_IDS_BY_PATH.get(tank_id)
        if tank_number is None:
            await reject_address(websocket, "Tank ID must be 1 or 2.")
            return
        await arena.serve(websocket, Role.TANK, tank_id=tank_number)

    @application.websocket("/ws/player/{tank_id}")
    async def player_socket(websocket: WebSocket, tank_id: str) -> None:
        tank_number = TANK_IDS_BY_PATH.get(tank_id)
        if tank_number is None:
            await reject_address(websocket, "Tank ID must be 1 or 2.")
            return
        names = websocket.query_params.getlist("name")
        if len(names) != 1 or not (name := names[0].strip()):
            await reject_address(websocket, "Provide a single non-empty player name.")
            return
        await arena.serve(websocket, Role.PLAYER, tank_id=tank_number, player_name=name)

    @application.websocket("/ws/control")
    async def control_socket(websocket: WebSocket) -> None:
        await arena.serve(websocket, Role.CONTROL)

    @application.websocket("/{path:path}")
    async def invalid_socket(websocket: WebSocket) -> None:
        await reject_address(websocket, "Invalid WebSocket path.")

    application.mount("/", FrontendFiles(directory=web_dist, check_dir=False), name="frontend")

    return application


app = create_app()
