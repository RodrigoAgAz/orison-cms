#!/usr/bin/env python3
"""Shared paths, configuration and durable file helpers for the in-cab services.

Standard library only, so every service (and the tests) can import it anywhere, including macOS.
"""

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


FIRMWARE_VERSION = "1.2.0"  # keep in sync with device/VERSION

BASE_DIR = Path(os.environ.get("ORISON_BASE_DIR", "/opt/orison"))
CONFIG_PATH = BASE_DIR / "config.json"
CONTENT_DIR = BASE_DIR / "content"
CURRENT_DIR = CONTENT_DIR / "current"
PREVIOUS_DIR = CONTENT_DIR / "previous"
STAGING_DIR = CONTENT_DIR / "staging"
FALLBACK_DIR = CONTENT_DIR / "fallback"
CACHE_DIR = CONTENT_DIR / "cache"
STATICS_DIRNAME = "statics"
SAFETY_META_NAME = "safety.json"
LOG_DIR = BASE_DIR / "logs"
RUNTIME_DIR = BASE_DIR / "runtime"
PLAYBACK_LOG_PATH = LOG_DIR / "playback.jsonl"
PLAYER_COMMAND_PATH = RUNTIME_DIR / "player_command.json"
PLAYER_STATE_PATH = RUNTIME_DIR / "player_state.json"
LAST_LOCATION_PATH = RUNTIME_DIR / "last_location.json"
SYNC_STATUS_PATH = RUNTIME_DIR / "sync_status.json"
SERVER_CONFIG_PATH = RUNTIME_DIR / "server_config.json"
VERIFIED_FILES_PATH = RUNTIME_DIR / "verified_files.json"
DEFAULT_STATIC_IMAGE_PATH = Path(__file__).resolve().with_name("orison_static_fallback.jpg")
DEFAULT_FALLBACK_CONTENT_PATH = FALLBACK_DIR / "orison_fallback.mp4"

PLAYBACK_TRIGGERS = ("auto", "gpio", "keyboard", "always")

# Clamp ranges from the device contract for values adopted from the heartbeat response.
HEARTBEAT_INTERVAL_RANGE = (60, 3600)
SYNC_INTERVAL_RANGE = (300, 86400)


def _as_int(value: Any, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        if isinstance(value, bool):
            raise ValueError
        result = int(value)
    except (TypeError, ValueError):
        return default
    if minimum is not None and result < minimum:
        result = minimum
    if maximum is not None and result > maximum:
        result = maximum
    return result


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"false", "0", "no", "off"}:
            return False
        if text in {"true", "1", "yes", "on"}:
            return True
        return default
    return bool(value)


@dataclass
class DeviceConfig:
    """config.json. Only `device.*` is required; every other key has a default, so config files
    written by older firmware (with none of the newer keys, or with keys nothing reads) still work."""

    raw: dict[str, Any]

    def section(self, name: str) -> dict[str, Any]:
        value = self.raw.get(name) if isinstance(self.raw, dict) else None
        return value if isinstance(value, dict) else {}

    @property
    def serial_number(self) -> str:
        return str(self.raw["device"]["serialNumber"])

    @property
    def api_base_url(self) -> str:
        return str(self.raw["device"]["apiBaseUrl"]).rstrip("/")

    @property
    def api_token(self) -> str:
        return str(self.raw["device"]["apiToken"])

    # --- sync -------------------------------------------------------------------------------
    @property
    def sync_interval_seconds(self) -> int:
        return _as_int(self.section("sync").get("checkIntervalSeconds"), 1800, 60)

    @property
    def max_download_retries(self) -> int:
        return _as_int(self.section("sync").get("maxDownloadRetries"), 3, 1, 20)

    @property
    def download_timeout_seconds(self) -> int:
        return _as_int(self.section("sync").get("downloadTimeoutSeconds"), 300, 5)

    @property
    def max_bandwidth_bytes_per_sec(self) -> int:
        return _as_int(self.section("sync").get("maxBandwidthBytesPerSec"), 2_000_000, 0)

    @property
    def min_free_space_mb(self) -> int:
        return _as_int(self.section("sync").get("minFreeSpaceMb"), 200, 0)

    @property
    def cache_max_mb(self) -> int:
        return _as_int(self.section("sync").get("cacheMaxMb"), 1024, 0)

    # --- playback ---------------------------------------------------------------------------
    @property
    def playback_trigger(self) -> str:
        value = str(self.section("playback").get("trigger") or "auto").strip().lower()
        return value if value in PLAYBACK_TRIGGERS else "auto"

    @property
    def always_safety_every_cycles(self) -> int:
        return _as_int(self.section("playback").get("alwaysSafetyEveryCycles"), 1, 1, 1000)

    @property
    def display(self) -> dict[str, Any]:
        section = self.section("playback").get("display")
        section = section if isinstance(section, dict) else {}
        return {
            "videoOutput": str(section.get("videoOutput") or "auto").strip(),
            "drmConnector": str(section.get("drmConnector") or "auto").strip(),
            "drmMode": str(section.get("drmMode") or "auto").strip(),
            "keepAspect": _as_bool(section.get("keepAspect"), True),
        }

    @property
    def fallback_content_path(self) -> Path:
        value = self.section("playback").get("fallbackContentPath")
        return Path(value) if isinstance(value, str) and value else DEFAULT_FALLBACK_CONTENT_PATH

    # --- location / modem -------------------------------------------------------------------
    @property
    def gps_enabled(self) -> bool:
        """location.gpsEnabled, default True; tolerant of a missing/odd section in older config.json files."""
        return _as_bool(self.section("location").get("gpsEnabled", True), True)

    @property
    def at_port(self) -> str:
        value = self.section("modem").get("atPort")
        return str(value).strip() if isinstance(value, str) and value.strip() else "auto"

    # --- health -----------------------------------------------------------------------------
    @property
    def heartbeat_interval_seconds(self) -> int:
        return _as_int(self.section("health").get("heartbeatIntervalSeconds"), 300, 30)

    @property
    def max_log_queue_bytes(self) -> int:
        return _as_int(self.section("health").get("maxLogQueueMb"), 50, 1) * 1024 * 1024


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_from_epoch(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
        CACHE_DIR,
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

    try:
        from logging.handlers import RotatingFileHandler

        file_handler: logging.Handler = RotatingFileHandler(
            LOG_DIR / filename, maxBytes=5 * 1024 * 1024, backupCount=3
        )
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except OSError:
        pass  # a read-only or full log dir must not stop the service; journald still has stderr

    return logger


# --- durable file operations ------------------------------------------------------------------


def fsync_dir(directory: Path) -> None:
    """Flush a directory entry (renames, creates) to disk. No-op where unsupported."""
    try:
        fd = os.open(str(directory), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def fsync_file(path: Path) -> None:
    try:
        with path.open("rb") as handle:
            os.fsync(handle.fileno())
    except OSError:
        pass


def fsync_tree(root: Path) -> None:
    """fsync every file and directory under root (used before a content directory is renamed live)."""
    if not root.exists():
        return
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            fsync_file(Path(dirpath) / name)
        fsync_dir(Path(dirpath))


def durable_replace(source: Path, target: Path) -> None:
    """Rename source over target so that after a power cut either the old or the complete new
    file is there: flush the data, rename, then flush the directory entry."""
    if source.is_file():
        fsync_file(source)
    os.replace(source, target)
    fsync_dir(target.parent)


def atomic_write_json(target: Path, payload: Any, *, durable: bool = True) -> None:
    """Write JSON via a temp file + rename. durable=False skips fsync (for runtime state files
    that are rewritten often and are worthless after a reboot)."""
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", delete=False, dir=target.parent, prefix=f".{target.name}.", suffix=".tmp", encoding="utf-8"
    ) as handle:
        json.dump(payload, handle, indent=2)
        handle.flush()
        if durable:
            os.fsync(handle.fileno())
        temp_name = handle.name
    os.replace(temp_name, target)
    if durable:
        fsync_dir(target.parent)


def read_json(target: Path, default: Any = None) -> Any:
    """Read JSON, returning `default` for a missing, unreadable, truncated or zero-length file.
    A bad local file must never take a service down (a power cut can leave any of these)."""
    try:
        with target.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def read_json_dict(target: Path) -> dict[str, Any]:
    value = read_json(target, None)
    return value if isinstance(value, dict) else {}


def sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def checksum_hex(checksum: Any) -> str | None:
    """'sha256:<64 hex>' -> '<64 hex>', anything else -> None."""
    if not isinstance(checksum, str):
        return None
    value = checksum.strip().lower()
    if value.startswith("sha256:"):
        value = value[len("sha256:"):]
    if len(value) == 64 and all(ch in "0123456789abcdef" for ch in value):
        return value
    return None


def append_jsonl(target: Path, payload: dict[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, separators=(",", ":")))
        handle.write("\n")


def read_jsonl(target: Path) -> list[dict[str, Any]]:
    try:
        handle = target.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return []

    items: list[dict[str, Any]] = []
    with handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                items.append(value)
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
    fsync_dir(target.parent)


# --- content layout ---------------------------------------------------------------------------


def current_manifest_path() -> Path:
    return CURRENT_DIR / "manifest.json"


def current_loop_file() -> Path:
    return CURRENT_DIR / "loop.mp4"


def current_safety_file(base_dir: Path | None = None) -> Path:
    return (base_dir or CURRENT_DIR) / "safety.mp4"


def current_safety_image_file(base_dir: Path | None = None) -> Path:
    return (base_dir or CURRENT_DIR) / "safety.jpg"


def statics_dir(base_dir: Path | None = None) -> Path:
    return (base_dir or CURRENT_DIR) / STATICS_DIRNAME


def slot_static_path(slot_index: int, base_dir: Path | None = None) -> Path:
    return statics_dir(base_dir) / f"slot_{slot_index:02d}.jpg"


def normalize_safety(value: Any) -> dict[str, Any] | None:
    """A usable safety descriptor ({url, checksum, durationMs, mimeType}) or None."""
    if not isinstance(value, dict) or not isinstance(value.get("url"), str) or not value.get("url"):
        return None
    result = {
        "url": value["url"],
        "checksum": value.get("checksum") if isinstance(value.get("checksum"), str) else None,
        "durationMs": _as_int(value.get("durationMs"), 0, 0),
        "mimeType": str(value.get("mimeType") or "video/mp4"),
    }
    return result


def safety_file_for(descriptor: dict[str, Any] | None, base_dir: Path | None = None) -> Path:
    if descriptor and str(descriptor.get("mimeType") or "").startswith("image/"):
        return current_safety_image_file(base_dir)
    return current_safety_file(base_dir)


def installed_safety(base_dir: Path | None = None) -> dict[str, Any] | None:
    """The safety message installed in a content directory, or None.

    safety.json (written by firmware 1.2.0+) is authoritative when present, because the server can
    now change the safety message independently of the loop. Content installed by older firmware
    has only the copy inside manifest.json. The file must exist and be non-empty to count.
    """
    directory = base_dir or CURRENT_DIR
    meta = read_json(directory / SAFETY_META_NAME, None)
    if isinstance(meta, dict) and "safetyVideo" in meta:
        descriptor = normalize_safety(meta.get("safetyVideo"))
    else:
        descriptor = normalize_safety(read_json_dict(directory / "manifest.json").get("safetyVideo"))
    if descriptor is None:
        return None
    path = safety_file_for(descriptor, directory)
    try:
        if path.stat().st_size <= 0:
            return None
    except OSError:
        return None
    return descriptor


def fallback_loop_file(config: DeviceConfig) -> Path:
    return config.fallback_content_path


def write_player_command(action: str, **extra: Any) -> None:
    atomic_write_json(
        PLAYER_COMMAND_PATH,
        {
            "action": action,
            "ts": utc_now_iso(),
            **extra,
        },
        durable=False,
    )


def copy_fallback_to_current(config: DeviceConfig) -> bool:
    """Install the bundled fallback video as current content. Returns False (and installs nothing)
    when the fallback file is missing: the player then shows the default still until a sync."""
    source = fallback_loop_file(config)
    try:
        if not source.is_file() or source.stat().st_size <= 0:
            return False
    except OSError:
        return False

    CURRENT_DIR.mkdir(parents=True, exist_ok=True)
    temp = CURRENT_DIR / "loop.mp4.tmp"
    shutil.copyfile(source, temp)
    durable_replace(temp, current_loop_file())
    (CURRENT_DIR / SAFETY_META_NAME).unlink(missing_ok=True)
    atomic_write_json(
        current_manifest_path(),
        {
            "version": "1.0",
            "loopId": "fallback",
            "loopName": "Fallback Branding Loop",
            "publishedAt": utc_now_iso(),
            "checksum": "sha256:fallback",
            # Unknown: the player measures the fallback video's real length.
            "totalDurationMs": None,
            "compiledVideoUrl": None,
            "compiledVideoChecksum": None,
            "slots": [],
            "totalDownloadSizeBytes": source.stat().st_size,
        },
    )
    return True


def build_headers(config: DeviceConfig) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {config.api_token}",
        "X-Device-Serial": config.serial_number,
        "Content-Type": "application/json",
    }


def effective_interval(config_value: int, server_key: str, bounds: tuple[int, int]) -> int:
    """An interval from the last heartbeat response's `config` (clamped), else config.json."""
    server = read_json_dict(SERVER_CONFIG_PATH)
    value = server.get(server_key)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return int(min(max(value, bounds[0]), bounds[1]))
    return config_value
