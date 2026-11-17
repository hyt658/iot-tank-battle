"""Start one Uvicorn worker using the selected TOML configuration."""

import logging

import uvicorn

from app.config import load_settings


def main() -> None:
    settings = load_settings()
    logging.basicConfig(level=settings.runtime.log_level)
    logging.getLogger(__name__).info(
        "Arena SSID=%s; WebSocket base=ws://%s:%s",
        settings.network.ssid,
        settings.network.arena_host,
        settings.network.port,
    )
    uvicorn.run(
        "app.main:app",
        host=settings.network.bind_host,
        port=settings.network.port,
        workers=1,
        ws="websockets-sansio",
        log_level=settings.runtime.log_level.lower(),
    )


if __name__ == "__main__":
    main()
