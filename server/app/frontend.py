"""Serve the frontend build and its client-side routes."""

from starlette.exceptions import HTTPException
from starlette.responses import PlainTextResponse, Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class FrontendFiles(StaticFiles):
    async def check_config(self) -> None:
        """Allow the server to run while the frontend build is missing."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        request_path = scope["path"]
        if (
            request_path == "/ws"
            or request_path.startswith("/ws/")
            or path.replace("\\", "/").partition("/")[0] == "ws"
        ):
            raise HTTPException(status_code=404)

        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise

        try:
            return await super().get_response("index.html", scope)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            return PlainTextResponse(
                "Frontend build not found. Run npm run build in web/.", status_code=503
            )
