"""Load deployment settings without changing the wire protocol."""

import os
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class NetworkSettings(ConfigModel):
    ssid: str = Field(min_length=1)
    arena_host: str = Field(min_length=1)
    bind_host: str = Field(min_length=1)
    port: int = Field(ge=1, le=65535)


class RuntimeSettings(ConfigModel):
    tick_interval_ms: int = Field(gt=0, le=200)
    outbound_queue_size: int = Field(ge=4)
    send_timeout_seconds: float = Field(gt=0)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


class Settings(ConfigModel):
    network: NetworkSettings
    runtime: RuntimeSettings


def load_settings(path: str | Path | None = None) -> Settings:
    selected = (
        path or os.environ.get("TANK_SERVER_CONFIG") or Path(__file__).with_name("config.toml")
    )
    with Path(selected).open("rb") as stream:
        return Settings.model_validate(tomllib.load(stream))
