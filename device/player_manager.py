#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from common import (
    CURRENT_DIR,
    PLAYER_COMMAND_PATH,
    PLAYER_STATE_PATH,
    PLAYBACK_LOG_PATH,
    append_jsonl,
    atomic_write_json,
    copy_fallback_to_current,
    current_loop_file,
    current_manifest_path,
    ensure_directories,
    load_config,
    read_json,
    setup_logger,
    utc_now_iso,
)


MPV_SOCKET_PATH = "/tmp/mpv-socket"


class PlayerManager:
    def __init__(self) -> None:
        self.config = load_config()
        self.logger = setup_logger("orison-player", "player.log")
        self.process: subprocess.Popen[str] | None = None
        self.schedule: list[dict[str, Any]] = []
        self.next_event_index = 0
        self.last_position_ms = 0.0
        self.consecutive_failures = 0

    def run(self) -> None:
        ensure_directories()
        if not current_loop_file().exists():
            copy_fallback_to_current(self.config)

        self.reload_manifest_schedule()
        self.start_player(current_loop_file())

        while True:
            try:
                if self.process and self.process.poll() is not None:
                    self.logger.warning("mpv exited unexpectedly with code %s", self.process.returncode)
                    self.consecutive_failures += 1
                    if self.consecutive_failures >= 10:
                        self.request_reboot()
                    self.start_player(current_loop_file())

                self.handle_commands()
                self.poll_playback()
                time.sleep(1)
            except Exception as error:  # noqa: BLE001
                self.logger.exception("player loop error: %s", error)
                time.sleep(5)

    def start_player(self, media_path: Path) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()

        if os.path.exists(MPV_SOCKET_PATH):
            os.unlink(MPV_SOCKET_PATH)

        command = [
            "mpv",
            "--fullscreen",
            "--loop-playlist=inf",
            "--no-terminal",
            "--no-input-default-bindings",
            "--hwdec=auto",
            "--vo=gpu",
            "--gpu-context=drm",
            "--drm-connector=HDMI-A-1",
            "--video-rotate=0",
            "--keepaspect=no",
            "--geometry=1280x800",
            "--no-osc",
            "--no-osd-bar",
            f"--input-ipc-server={MPV_SOCKET_PATH}",
            str(media_path),
        ]

        self.logger.info("starting mpv with %s", media_path)
        self.process = subprocess.Popen(command)
        self.last_position_ms = 0
        self.next_event_index = 0
        self.consecutive_failures = 0

    def handle_commands(self) -> None:
        command = read_json(PLAYER_COMMAND_PATH)
        if not command:
            return

        action = command.get("action")
        if action == "reload":
            self.reload_manifest_schedule()
            self.load_file(current_loop_file())
            self.last_position_ms = 0
            self.next_event_index = 0

        PLAYER_COMMAND_PATH.unlink(missing_ok=True)

    def load_file(self, media_path: Path) -> None:
        if not self.send_mpv_command({"command": ["loadfile", str(media_path), "replace"]}):
            self.logger.warning("mpv IPC unavailable, restarting process")
            self.start_player(media_path)

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

    def get_time_pos_seconds(self) -> float | None:
        if not os.path.exists(MPV_SOCKET_PATH):
            return None

        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(MPV_SOCKET_PATH)
                client.sendall(b'{"command":["get_property","time-pos"]}\n')
                response = client.recv(4096).decode("utf-8")
            payload = json.loads(response)
            return float(payload.get("data") or 0.0)
        except (OSError, ValueError, json.JSONDecodeError):
            return None

    def poll_playback(self) -> None:
        time_pos_seconds = self.get_time_pos_seconds()
        if time_pos_seconds is None:
            self.write_state("error", 0.0)
            return

        time_pos_ms = time_pos_seconds * 1000
        if time_pos_ms + 3000 < self.last_position_ms:
            self.next_event_index = 0
        self.last_position_ms = time_pos_ms

        while self.next_event_index < len(self.schedule):
            event = self.schedule[self.next_event_index]
            if event["absoluteStartMs"] > time_pos_ms:
                break
            self.log_event(event)
            self.next_event_index += 1

        manifest = read_json(current_manifest_path(), {})
        self.write_state("playing", time_pos_seconds, manifest.get("loopId"))

    def log_event(self, event: dict[str, Any]) -> None:
        payload = {
            "slotPosition": event["slotPosition"],
            "contentType": event["contentType"],
            "assetId": event["assetId"],
            "playedAt": utc_now_iso(),
            "completedFull": True,
        }
        append_jsonl(PLAYBACK_LOG_PATH, payload)

    def reload_manifest_schedule(self) -> None:
        manifest = read_json(current_manifest_path(), {})
        slots = manifest.get("slots", [])
        schedule: list[dict[str, Any]] = []

        for slot in sorted(slots, key=lambda item: item.get("position", 0)):
            slot_position = int(slot.get("position", 0))
            slot_offset = slot_position * 60000
            for content in sorted(slot.get("contents", []), key=lambda item: item.get("startTimeMs", 0)):
                schedule.append(
                    {
                        "absoluteStartMs": slot_offset + int(content.get("startTimeMs", 0)),
                        "slotPosition": slot_position,
                        "contentType": content.get("type", "FILLER"),
                        "assetId": content.get("assetId"),
                    }
                )

        self.schedule = schedule

    def write_state(self, status: str, time_pos_seconds: float, loop_id: str | None = None) -> None:
        atomic_write_json(
            PLAYER_STATE_PATH,
            {
                "status": status,
                "timePosSeconds": time_pos_seconds,
                "loopId": loop_id,
                "updatedAt": utc_now_iso(),
            },
        )

    def request_reboot(self) -> None:
        self.logger.error("mpv failed repeatedly, requesting reboot")
        subprocess.run(["systemctl", "reboot"], check=False)


if __name__ == "__main__":
    PlayerManager().run()
