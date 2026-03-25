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
DEFAULT_STATIC_IMAGE_PATH = SCRIPT_DIR / "orison_static_fallback.jpg"
MPV_SOCKET_PATH = "/tmp/orison-demo-mpv.sock"
CHUNK_SIZE = 1024 * 1024
VIDEO_MODE = "VIDEO_MODE"
SILENT_MODE = "SILENT_MODE"

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


def ensure_latest_loop(config: dict[str, Any]) -> dict[str, Any]:
    remote_manifest = fetch_manifest_info(config)
    local_manifest = load_local_manifest()
    slot_lookup = {int(slot.get("position", 0)): slot for slot in remote_manifest.get("slots", [])}

    remote_checksum = str(remote_manifest.get("checksum") or "")
    local_checksum = str(local_manifest.get("checksum") or "") if local_manifest else ""

    if LOOP_PATH.exists() and remote_checksum and remote_checksum == local_checksum:
        expected_loop_checksum = remote_manifest.get("compiledVideoChecksum")
        if expected_loop_checksum and sha256_file(LOOP_PATH) != expected_loop_checksum:
            print("Cached loop checksum mismatch. Re-downloading current loop.")
        else:
            for slot_index in range(10):
                ensure_slot_static(slot_index, slot_lookup.get(slot_index))
            print(f"Using cached loop {remote_manifest.get('loopId')}.")
            return remote_manifest

    compiled_video_url = remote_manifest.get("compiledVideoUrl")
    if not compiled_video_url:
        raise RuntimeError("Manifest did not include a compiledVideoUrl.")

    print(f"New loop available: {remote_manifest.get('loopName', remote_manifest.get('loopId', 'unknown'))}")
    download_file(str(compiled_video_url), LOOP_PATH, remote_manifest.get("compiledVideoChecksum"), "Downloading loop.mp4")

    for slot_index in range(10):
        ensure_slot_static(slot_index, slot_lookup.get(slot_index))

    save_manifest(remote_manifest)
    return remote_manifest


class DemoPlayer:
    def __init__(self, manifest: dict[str, Any]) -> None:
        self.manifest = manifest
        self.process: subprocess.Popen[str] | None = None
        self.mode = VIDEO_MODE
        self.loop_started_monotonic = time.monotonic()
        self.last_silent_slot_index: int | None = None

    def start(self) -> None:
        self.start_mpv(LOOP_PATH)
        print("Press spacebar to toggle silent mode. Ctrl+C to stop.")
        self.event_loop()

    def start_mpv(self, media_path: Path) -> None:
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
                "--loop-file=inf",
                "--image-display-duration=inf",
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

    def load_file(self, media_path: Path) -> None:
        if not self.send_mpv_command({"command": ["loadfile", str(media_path), "replace"]}):
            self.start_mpv(media_path)

    def seek_video_to_elapsed(self, elapsed_seconds: float) -> None:
        self.send_mpv_command({"command": ["seek", max(elapsed_seconds, 0.0), "absolute", "exact"]})

    def loop_duration_seconds(self) -> float:
        duration_ms = self.manifest.get("totalDurationMs")
        try:
            duration_seconds = float(duration_ms) / 1000.0
            if duration_seconds > 0:
                return duration_seconds
        except (TypeError, ValueError):
            pass
        return 600.0

    def elapsed_seconds(self) -> float:
        return (time.monotonic() - self.loop_started_monotonic) % self.loop_duration_seconds()

    def current_slot_index(self) -> int:
        return int(self.elapsed_seconds() // 60) % 10

    def static_path_for_slot(self, slot_index: int) -> Path:
        path = STATICS_DIR / f"slot_{slot_index:02d}.jpg"
        if path.exists():
            return path
        return DEFAULT_STATIC_IMAGE_PATH

    def toggle_mode(self) -> None:
        if self.mode == VIDEO_MODE:
            slot_index = self.current_slot_index()
            self.load_file(self.static_path_for_slot(slot_index))
            self.mode = SILENT_MODE
            self.last_silent_slot_index = slot_index
            return

        elapsed = self.elapsed_seconds()
        self.load_file(LOOP_PATH)
        time.sleep(0.25)
        self.seek_video_to_elapsed(elapsed)
        self.mode = VIDEO_MODE
        self.last_silent_slot_index = None

    def sync_silent_mode(self) -> None:
        if self.mode != SILENT_MODE:
            return

        slot_index = self.current_slot_index()
        if slot_index == self.last_silent_slot_index:
            return

        self.load_file(self.static_path_for_slot(slot_index))
        self.last_silent_slot_index = slot_index

    def event_loop(self) -> None:
        if not sys.stdin.isatty():
            while self.process and self.process.poll() is None:
                self.sync_silent_mode()
                time.sleep(1)
            return

        fd = sys.stdin.fileno()
        previous_settings = termios.tcgetattr(fd)

        try:
            tty.setcbreak(fd)
            while self.process and self.process.poll() is None:
                readable, _, _ = select.select([sys.stdin], [], [], 1.0)
                if readable and sys.stdin.read(1) == " ":
                    self.toggle_mode()
                self.sync_silent_mode()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, previous_settings)


def main() -> None:
    config = ensure_config()
    ensure_mpv_installed()
    manifest = ensure_latest_loop(config)
    print(f"Ready to play loop {manifest.get('loopId')} ({manifest.get('totalDurationMs')} ms).")
    DemoPlayer(manifest).start()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
