#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import termios
import time
import tty
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_PATH = SCRIPT_DIR / "config.json"
CONTENT_DIR = SCRIPT_DIR / "demo_content"
STATICS_DIR = CONTENT_DIR / "statics"
MANIFEST_PATH = CONTENT_DIR / "manifest.json"
LOOP_PATH = CONTENT_DIR / "loop.mp4"
SAFETY_VIDEO_PATH = CONTENT_DIR / "safety.mp4"
SAFETY_IMAGE_PATH = CONTENT_DIR / "safety.jpg"
DEFAULT_STATIC_IMAGE_PATH = SCRIPT_DIR / "orison_static_fallback.jpg"
MPV_SOCKET_PATH = "/tmp/orison-demo-mpv.sock"
CHUNK_SIZE = 1024 * 1024
WIND_DOWN_SECONDS = 5


class DemoState(Enum):
    IDLE = "IDLE"
    SAFETY = "SAFETY"
    JOURNEY = "JOURNEY"
    SILENT = "SILENT"
    WIND_DOWN = "WIND_DOWN"
    DISABLED = "DISABLED"


DEFAULT_CONFIG = {
    "device": {
        "serialNumber": "ORISON-TEST-001",
        "apiBaseUrl": "https://orison-cms-production.up.railway.app/api",
        "apiToken": "orison-pilot-2026",
    }
}


def ensure_mpv_installed() -> None:
    if shutil.which("mpv"):
        return

    print("Run: brew install mpv")
    raise SystemExit(1)


def ensure_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        with CONFIG_PATH.open("w", encoding="utf-8") as handle:
            json.dump(DEFAULT_CONFIG, handle, indent=2)
            handle.write("\n")
        os.chmod(CONFIG_PATH, 0o600)
        print(f"Created {CONFIG_PATH.name} with demo defaults.")

    with CONFIG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_local_manifest() -> dict[str, Any] | None:
    if not MANIFEST_PATH.exists():
        return None

    with MANIFEST_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_manifest(manifest: dict[str, Any]) -> None:
    CONTENT_DIR.mkdir(parents=True, exist_ok=True)
    with MANIFEST_PATH.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")


def sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def build_headers(config: dict[str, Any]) -> dict[str, str]:
    device = config["device"]
    return {
        "Authorization": f"Bearer {device['apiToken']}",
        "X-Device-Serial": str(device["serialNumber"]),
    }


def fetch_manifest_info(config: dict[str, Any]) -> dict[str, Any]:
    url = f"{str(config['device']['apiBaseUrl']).rstrip('/')}/devices/manifest"
    request = Request(url, headers=build_headers(config), method="GET")

    try:
        with urlopen(request, timeout=30) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return json.loads(response.read().decode(charset))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace").strip()
        message = body or error.reason
        raise RuntimeError(f"Manifest request failed ({error.code}): {message}") from error
    except URLError as error:
        raise RuntimeError(f"Manifest request failed: {error.reason}") from error


def print_progress(label: str, downloaded: int, total: int | None) -> None:
    if total and total > 0:
        percent = min(int(downloaded * 100 / total), 100)
        size_mb = downloaded / (1024 * 1024)
        total_mb = total / (1024 * 1024)
        print(f"\r{label}: {percent:3d}%  {size_mb:6.1f}/{total_mb:6.1f} MB", end="", flush=True)
        return

    size_mb = downloaded / (1024 * 1024)
    print(f"\r{label}: {size_mb:6.1f} MB", end="", flush=True)


def download_file(url: str, target_path: Path, expected_checksum: str | None, label: str) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile("wb", delete=False, dir=target_path.parent, suffix=".part") as handle:
        temp_path = Path(handle.name)

    request = Request(url, method="GET")
    downloaded = 0

    try:
        with urlopen(request, timeout=300) as response, temp_path.open("wb") as handle:
            total_header = response.headers.get("Content-Length")
            total = int(total_header) if total_header and total_header.isdigit() else None

            while True:
                chunk = response.read(CHUNK_SIZE)
                if not chunk:
                    break
                handle.write(chunk)
                downloaded += len(chunk)
                print_progress(label, downloaded, total)

        print()

        if expected_checksum:
            actual_checksum = sha256_file(temp_path)
            if actual_checksum != expected_checksum:
                raise RuntimeError(
                    f"Downloaded file checksum mismatch. Expected {expected_checksum}, got {actual_checksum}."
                )

        temp_path.replace(target_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def download_json(url: str, expected_checksum: str | None, label: str) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=CONTENT_DIR if CONTENT_DIR.exists() else None, suffix=".json") as handle:
        temp_path = Path(handle.name)

    try:
        download_file(url, temp_path, None, label)
        with temp_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if expected_checksum and payload.get("checksum") != expected_checksum:
            raise RuntimeError("Manifest checksum mismatch.")
        return payload
    finally:
        temp_path.unlink(missing_ok=True)


def ensure_slot_static(slot_index: int, slot_payload: dict[str, Any] | None) -> None:
    static_target = STATICS_DIR / f"slot_{slot_index:02d}.jpg"
    static_url = slot_payload.get("staticImageUrl") if slot_payload else None
    static_checksum = slot_payload.get("staticImageChecksum") if slot_payload else None

    if static_url:
        download_file(str(static_url), static_target, static_checksum, f"Downloading static {slot_index:02d}")
        return

    if not DEFAULT_STATIC_IMAGE_PATH.exists():
        raise RuntimeError(f"Default static image is missing: {DEFAULT_STATIC_IMAGE_PATH}")

    STATICS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(DEFAULT_STATIC_IMAGE_PATH, static_target)


def ensure_safety_video(manifest: dict[str, Any]) -> None:
    safety_payload = manifest.get("safetyVideo") or {}
    safety_url = safety_payload.get("url")
    safety_mime_type = str(safety_payload.get("mimeType") or "video/mp4")
    if safety_url:
        safety_path = SAFETY_IMAGE_PATH if safety_mime_type.startswith("image/") else SAFETY_VIDEO_PATH
        download_file(
            str(safety_url),
            safety_path,
            safety_payload.get("checksum"),
            f"Downloading {safety_path.name}",
        )
        if safety_path != SAFETY_VIDEO_PATH:
            SAFETY_VIDEO_PATH.unlink(missing_ok=True)
        if safety_path != SAFETY_IMAGE_PATH:
            SAFETY_IMAGE_PATH.unlink(missing_ok=True)
        return

    SAFETY_VIDEO_PATH.unlink(missing_ok=True)
    SAFETY_IMAGE_PATH.unlink(missing_ok=True)


def ensure_latest_loop(config: dict[str, Any]) -> dict[str, Any]:
    manifest_info = fetch_manifest_info(config)
    local_manifest = load_local_manifest()
    remote_checksum = str(manifest_info.get("checksum") or "")
    local_checksum = str(local_manifest.get("checksum") or "") if local_manifest else ""

    if LOOP_PATH.exists() and local_manifest and remote_checksum and remote_checksum == local_checksum:
        local_manifest["disabled"] = bool(manifest_info.get("disabled"))
        local_manifest["disabledReason"] = manifest_info.get("disabledReason")
        print(f"Using cached loop {local_manifest.get('loopId')}.")
        return local_manifest

    manifest_url = manifest_info.get("manifestUrl")
    if not manifest_url:
        raise RuntimeError("Manifest response did not include manifestUrl.")

    manifest = download_json(str(manifest_url), manifest_info.get("checksum"), "Downloading manifest.json")
    manifest["disabled"] = bool(manifest_info.get("disabled"))
    manifest["disabledReason"] = manifest_info.get("disabledReason")

    compiled_video_url = manifest.get("compiledVideoUrl") or manifest_info.get("compiledVideoUrl")
    if not compiled_video_url:
        raise RuntimeError("Manifest did not include a compiledVideoUrl.")

    print(f"New loop available: {manifest.get('loopName', manifest.get('loopId', 'unknown'))}")
    download_file(str(compiled_video_url), LOOP_PATH, manifest.get("compiledVideoChecksum"), "Downloading loop.mp4")

    slot_lookup = {int(slot.get("position", 0)): slot for slot in manifest.get("slots", [])}
    for slot_index in range(10):
        ensure_slot_static(slot_index, slot_lookup.get(slot_index))

    ensure_safety_video(manifest)
    save_manifest(manifest)
    return manifest


class DemoPlayer:
    def __init__(self, manifest: dict[str, Any]) -> None:
        self.manifest = manifest
        self.process: subprocess.Popen[str] | None = None
        self.state = DemoState.DISABLED if manifest.get("disabled") else DemoState.IDLE
        self.loop_started_monotonic: float | None = None
        self.idle_started_monotonic = time.monotonic()
        self.wind_down_started_monotonic: float | None = None
        self.safety_started_monotonic: float | None = None
        self.last_silent_slot_index: int | None = None
        self.last_idle_slot_index: int | None = None

    def start(self) -> None:
        self.start_mpv(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)
        self.transition(self.state, reset_idle_clock=True)
        print("Controls: j start/end journey, space mute/unmute, d driver override, Ctrl+C to stop.")
        self.event_loop()

    def start_mpv(self, media_path: Path, *, loop_forever: bool) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()

        if os.path.exists(MPV_SOCKET_PATH):
            os.unlink(MPV_SOCKET_PATH)

        self.process = subprocess.Popen(
            [
                "mpv",
                "--fullscreen=yes",
                f"--loop-file={'inf' if loop_forever else 'no'}",
                "--image-display-duration=inf",
                "--keep-open=yes",
                f"--input-ipc-server={MPV_SOCKET_PATH}",
                str(media_path),
            ],
        )

    def send_mpv_command(self, payload: dict[str, Any]) -> bool:
        if not os.path.exists(MPV_SOCKET_PATH):
            return False

        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(MPV_SOCKET_PATH)
                client.sendall((json.dumps(payload) + "\n").encode("utf-8"))
                client.recv(4096)
            return True
        except OSError:
            return False

    def load_file(self, media_path: Path, *, loop_forever: bool) -> None:
        if not self.send_mpv_command({"command": ["set_property", "loop-file", "inf" if loop_forever else "no"]}):
            self.start_mpv(media_path, loop_forever=loop_forever)
            return

        if not self.send_mpv_command({"command": ["loadfile", str(media_path), "replace"]}):
            self.start_mpv(media_path, loop_forever=loop_forever)

    def get_mpv_property(self, property_name: str) -> Any | None:
        if not os.path.exists(MPV_SOCKET_PATH):
            return None

        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(MPV_SOCKET_PATH)
                client.sendall((json.dumps({"command": ["get_property", property_name]}) + "\n").encode("utf-8"))
                response = client.recv(4096).decode("utf-8")
            payload = json.loads(response)
            if payload.get("error") not in (None, "success"):
                return None
            return payload.get("data")
        except (OSError, json.JSONDecodeError):
            return None

    def journey_elapsed_seconds(self) -> float:
        if self.loop_started_monotonic is None:
            return 0.0
        return max(time.monotonic() - self.loop_started_monotonic, 0.0)

    def current_loop_duration_seconds(self) -> float:
        duration_ms = self.manifest.get("totalDurationMs")
        try:
            duration_seconds = float(duration_ms) / 1000.0
            if duration_seconds > 0:
                return duration_seconds
        except (TypeError, ValueError):
            pass
        return 600.0

    def current_slot_index(self) -> int:
        return int(self.journey_elapsed_seconds() // 60) % 10

    def idle_slot_index(self) -> int:
        return int((time.monotonic() - self.idle_started_monotonic) // 60) % 10

    def static_path_for_slot(self, slot_index: int) -> Path:
        path = STATICS_DIR / f"slot_{slot_index:02d}.jpg"
        if path.exists():
            return path
        return DEFAULT_STATIC_IMAGE_PATH

    def safety_finished(self) -> bool:
        if self.safety_is_image():
            if self.safety_started_monotonic is None:
                return False
            duration_ms = int((self.manifest.get("safetyVideo") or {}).get("durationMs") or 0)
            return time.monotonic() - self.safety_started_monotonic >= max(duration_ms, 0) / 1000.0

        eof_reached = self.get_mpv_property("eof-reached")
        if eof_reached is True:
            return True

        time_pos = self.get_mpv_property("time-pos")
        duration_ms = int((self.manifest.get("safetyVideo") or {}).get("durationMs") or 0)
        if time_pos is None or duration_ms <= 0:
            return False
        return float(time_pos) * 1000 >= max(duration_ms - 250, 0)

    def current_safety_path(self) -> Path:
        if self.safety_is_image() and SAFETY_IMAGE_PATH.exists():
            return SAFETY_IMAGE_PATH
        if SAFETY_VIDEO_PATH.exists():
            return SAFETY_VIDEO_PATH
        return SAFETY_IMAGE_PATH

    def safety_is_image(self) -> bool:
        return str((self.manifest.get("safetyVideo") or {}).get("mimeType") or "").startswith("image/")

    def transition(self, new_state: DemoState, *, reset_idle_clock: bool = False) -> None:
        previous_state = self.state
        self.state = new_state
        if new_state != DemoState.SAFETY:
            self.safety_started_monotonic = None

        if new_state == DemoState.DISABLED:
            self.load_file(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)
            return

        if new_state == DemoState.IDLE:
            self.loop_started_monotonic = None
            self.last_silent_slot_index = None
            if reset_idle_clock:
                self.idle_started_monotonic = time.monotonic()
            self.last_idle_slot_index = None
            self.show_idle_slot(force_reload=True)
            return

        if new_state == DemoState.SAFETY:
            safety_path = self.current_safety_path()
            if not safety_path.exists():
                self.loop_started_monotonic = time.monotonic()
                self.transition(DemoState.JOURNEY)
                return

            self.safety_started_monotonic = time.monotonic()
            self.load_file(safety_path, loop_forever=False)
            return

        if new_state == DemoState.JOURNEY:
            if self.loop_started_monotonic is None:
                self.loop_started_monotonic = time.monotonic()
            if previous_state == DemoState.SAFETY and self.safety_is_image():
                self.start_mpv(LOOP_PATH, loop_forever=True)
            else:
                self.load_file(LOOP_PATH, loop_forever=True)
            self.send_mpv_command(
                {
                    "command": [
                        "seek",
                        self.journey_elapsed_seconds() % self.current_loop_duration_seconds(),
                        "absolute",
                        "exact",
                    ]
                }
            )
            return

        if new_state == DemoState.SILENT:
            self.last_silent_slot_index = None
            self.show_silent_slot(force_reload=True)
            return

        if new_state == DemoState.WIND_DOWN:
            self.wind_down_started_monotonic = time.monotonic()
            self.load_file(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)

    def start_or_end_journey(self) -> None:
        if self.state == DemoState.DISABLED:
            return

        if self.state == DemoState.IDLE:
            self.transition(DemoState.SAFETY)
            return

        if self.state == DemoState.SAFETY:
            self.transition(DemoState.IDLE, reset_idle_clock=True)
            return

        self.transition(DemoState.WIND_DOWN)

    def driver_override(self) -> None:
        if self.state in {DemoState.SAFETY, DemoState.DISABLED, DemoState.IDLE}:
            return
        self.transition(DemoState.WIND_DOWN)

    def toggle_silent(self) -> None:
        if self.state == DemoState.JOURNEY:
            self.transition(DemoState.SILENT)
        elif self.state == DemoState.SILENT:
            self.transition(DemoState.JOURNEY)

    def show_idle_slot(self, *, force_reload: bool = False) -> None:
        slot_index = self.idle_slot_index()
        if force_reload or slot_index != self.last_idle_slot_index:
            self.load_file(self.static_path_for_slot(slot_index), loop_forever=False)
            self.last_idle_slot_index = slot_index

    def show_silent_slot(self, *, force_reload: bool = False) -> None:
        slot_index = self.current_slot_index()
        if force_reload or slot_index != self.last_silent_slot_index:
            self.load_file(self.static_path_for_slot(slot_index), loop_forever=False)
            self.last_silent_slot_index = slot_index

    def tick(self) -> None:
        if self.state == DemoState.DISABLED:
            return

        if self.state == DemoState.IDLE:
            self.show_idle_slot()
            return

        if self.state == DemoState.SAFETY and self.safety_finished():
            self.loop_started_monotonic = time.monotonic()
            self.transition(DemoState.JOURNEY)
            return

        if self.state == DemoState.SILENT:
            self.show_silent_slot()
            return

        if self.state == DemoState.WIND_DOWN and self.wind_down_started_monotonic:
            if time.monotonic() - self.wind_down_started_monotonic >= WIND_DOWN_SECONDS:
                self.transition(DemoState.IDLE, reset_idle_clock=True)

    def event_loop(self) -> None:
        if not sys.stdin.isatty():
            while self.process and self.process.poll() is None:
                self.tick()
                time.sleep(1)
            return

        fd = sys.stdin.fileno()
        previous_settings = termios.tcgetattr(fd)

        try:
            tty.setcbreak(fd)
            while self.process and self.process.poll() is None:
                readable, _, _ = select.select([sys.stdin], [], [], 1.0)
                if readable:
                    key = sys.stdin.read(1)
                    if key == " ":
                        self.toggle_silent()
                    elif key.lower() == "j":
                        self.start_or_end_journey()
                    elif key.lower() == "d":
                        self.driver_override()
                self.tick()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, previous_settings)


def main() -> None:
    config = ensure_config()
    ensure_mpv_installed()
    manifest = ensure_latest_loop(config)
    print(
        "Ready to play loop "
        f"{manifest.get('loopId')} ({manifest.get('totalDurationMs')} ms)"
        f"{' [DISABLED]' if manifest.get('disabled') else ''}."
    )
    DemoPlayer(manifest).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
