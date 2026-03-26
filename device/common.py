#!/usr/bin/env python3

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any


BASE_DIR = Path(os.environ.get("ORISON_BASE_DIR", "/opt/orison"))
CONFIG_PATH = BASE_DIR / "config.json"
CONTENT_DIR = BASE_DIR / "content"
CURRENT_DIR = CONTENT_DIR / "current"
PREVIOUS_DIR = CONTENT_DIR / "previous"
STAGING_DIR = CONTENT_DIR / "staging"
FALLBACK_DIR = CONTENT_DIR / "fallback"
STATICS_DIRNAME = "statics"
LOG_DIR = BASE_DIR / "logs"
RUNTIME_DIR = BASE_DIR / "runtime"
PLAYBACK_LOG_PATH = LOG_DIR / "playback.jsonl"
PLAYER_COMMAND_PATH = RUNTIME_DIR / "player_command.json"
PLAYER_STATE_PATH = RUNTIME_DIR / "player_state.json"
LAST_LOCATION_PATH = RUNTIME_DIR / "last_location.json"
DEFAULT_STATIC_IMAGE_PATH = Path(__file__).resolve().with_name("orison_static_fallback.jpg")


@dataclass
class DeviceConfig:
    raw: dict[str, Any]

    @property
    def serial_number(self) -> str:
        return str(self.raw["device"]["serialNumber"])

    @property
    def api_base_url(self) -> str:
        return str(self.raw["device"]["apiBaseUrl"]).rstrip("/")

    @property
    def api_token(self) -> str:
        return str(self.raw["device"]["apiToken"])

    @property
    def cdn_base_url(self) -> str:
        return str(self.raw["device"].get("cdnBaseUrl", "")).rstrip("/")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_config() -> DeviceConfig:
    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return DeviceConfig(json.load(handle))


def ensure_directories() -> None:
    for directory in [
        BASE_DIR,
        CONTENT_DIR,
        CURRENT_DIR,
        PREVIOUS_DIR,
        STAGING_DIR,
        FALLBACK_DIR,
        LOG_DIR,
        RUNTIME_DIR,
    ]:
        directory.mkdir(parents=True, exist_ok=True)


def setup_logger(name: str, filename: str) -> logging.Logger:
    ensure_directories()
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    file_handler = logging.FileHandler(LOG_DIR / filename)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger


def atomic_write_json(target: Path, payload: dict[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=target.parent, encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
        temp_name = handle.name
    os.replace(temp_name, target)


def read_json(target: Path, default: Any = None) -> Any:
    if not target.exists():
        return default

    with target.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def current_manifest_path() -> Path:
    return CURRENT_DIR / "manifest.json"


def current_loop_file() -> Path:
    return CURRENT_DIR / "loop.mp4"


def current_safety_file(base_dir: Path | None = None) -> Path:
    return (base_dir or CURRENT_DIR) / "safety.mp4"


def statics_dir(base_dir: Path | None = None) -> Path:
    return (base_dir or CURRENT_DIR) / STATICS_DIRNAME


def slot_static_path(slot_index: int, base_dir: Path | None = None) -> Path:
    return statics_dir(base_dir) / f"slot_{slot_index:02d}.jpg"


def fallback_loop_file(config: DeviceConfig) -> Path:
    return Path(config.raw["playback"]["fallbackContentPath"])


def write_player_command(action: str, **extra: Any) -> None:
    atomic_write_json(
        PLAYER_COMMAND_PATH,
        {
            "action": action,
            "ts": utc_now_iso(),
            **extra,
        },
    )


def append_jsonl(target: Path, payload: dict[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, separators=(",", ":")))
        handle.write("\n")


def read_jsonl(target: Path) -> list[dict[str, Any]]:
    if not target.exists():
        return []

    items: list[dict[str, Any]] = []
    with target.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return items


def rewrite_jsonl(target: Path, items: list[dict[str, Any]]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=target.parent, encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, separators=(",", ":")))
            handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
        temp_name = handle.name
    os.replace(temp_name, target)


def copy_fallback_to_current(config: DeviceConfig) -> None:
    source = fallback_loop_file(config)
    if not source.exists():
        raise FileNotFoundError(f"Fallback file is missing: {source}")

    CURRENT_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, current_loop_file())
    atomic_write_json(
        current_manifest_path(),
        {
            "version": "1.0",
            "loopId": "fallback",
            "loopName": "Fallback Branding Loop",
            "publishedAt": utc_now_iso(),
            "checksum": "sha256:fallback",
            "totalDurationMs": 600000,
            "compiledVideoUrl": None,
            "compiledVideoChecksum": None,
            "slots": [],
            "totalDownloadSizeBytes": source.stat().st_size,
        },
    )


def build_headers(config: DeviceConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {config.api_token}",
        "X-Device-Serial": config.serial_number,
        "Content-Type": "application/json",
    }
