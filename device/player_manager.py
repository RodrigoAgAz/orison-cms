#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import select
import socket
import subprocess
import sys
import termios
import threading
import time
import tty
from pathlib import Path
from typing import Any

from common import (
    CURRENT_DIR,
    DEFAULT_STATIC_IMAGE_PATH,
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
    slot_static_path,
    utc_now_iso,
)


MPV_SOCKET_PATH = "/tmp/mpv-socket"
LOAD_CONFIRMATION_TIMEOUT_SECONDS = 15
BUTTON_PIN = 17
VIDEO_MODE = "VIDEO_MODE"
SILENT_MODE = "SILENT_MODE"


class PlayerManager:
    def __init__(self) -> None:
        self.config = load_config()
        self.logger = setup_logger("orison-player", "player.log")
        self.process: subprocess.Popen[str] | None = None
        self.schedule: list[dict[str, Any]] = []
        self.next_event_index = 0
        self.last_position_ms = 0.0
        self.consecutive_failures = 0
        self.mode = VIDEO_MODE
        self.loop_started_monotonic = time.monotonic()
        self.last_silent_slot_index: int | None = None
        self.gpio = None

    def run(self) -> None:
        ensure_directories()
        if not current_loop_file().exists():
            copy_fallback_to_current(self.config)

        self.reload_manifest_schedule()
        self.start_player(current_loop_file())
        self.start_input_listeners()

        while True:
            try:
                if self.process and self.process.poll() is not None:
                    self.logger.warning("mpv exited unexpectedly with code %s", self.process.returncode)
                    self.consecutive_failures += 1
                    if self.consecutive_failures >= 10:
                        self.request_reboot()
                    self.restart_for_current_mode()

                self.handle_commands()
                self.poll_playback()
                if self.mode == SILENT_MODE:
                    self.sync_silent_mode_display()
                time.sleep(1)
            except Exception as error:  # noqa: BLE001
                self.logger.exception("player loop error: %s", error)
                time.sleep(2)

    def start_input_listeners(self) -> None:
        self.configure_gpio_button()
        self.configure_keyboard_listener()

    def configure_gpio_button(self) -> None:
        try:
            import RPi.GPIO as gpio  # type: ignore[import-not-found]
        except Exception:
            self.logger.info("RPi.GPIO unavailable, GPIO silent-mode button disabled")
            return

        self.gpio = gpio
        try:
            gpio.setmode(gpio.BCM)
            gpio.setup(BUTTON_PIN, gpio.IN, pull_up_down=gpio.PUD_UP)
            gpio.add_event_detect(BUTTON_PIN, gpio.FALLING, callback=self.on_button_press, bouncetime=350)
            self.logger.info("configured GPIO silent-mode button on BCM %s", BUTTON_PIN)
        except Exception as error:  # noqa: BLE001
            self.logger.warning("failed to configure GPIO button: %s", error)

    def configure_keyboard_listener(self) -> None:
        if not sys.stdin.isatty():
            self.logger.info("stdin is not interactive, keyboard silent-mode toggle disabled")
            return

        thread = threading.Thread(target=self.keyboard_loop, daemon=True, name="keyboard-toggle")
        thread.start()
        self.logger.info("configured keyboard fallback for silent mode (spacebar)")

    def keyboard_loop(self) -> None:
        fd = sys.stdin.fileno()
        previous_settings = termios.tcgetattr(fd)

        try:
            tty.setcbreak(fd)
            while True:
                readable, _, _ = select.select([sys.stdin], [], [], 1.0)
                if not readable:
                    continue
                key = sys.stdin.read(1)
                if key == " ":
                    self.on_button_press()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, previous_settings)

    def on_button_press(self, _channel: Any = None) -> None:
        if self.mode == VIDEO_MODE:
            self.switch_to_silent_mode()
            return

        self.switch_to_video_mode()

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
            "--loop-file=inf",
            "--image-display-duration=inf",
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
        self.consecutive_failures = 0

    def restart_for_current_mode(self) -> None:
        if self.mode == SILENT_MODE:
            slot_index = self.current_slot_index()
            self.start_player(self.static_path_for_slot(slot_index))
            self.last_silent_slot_index = slot_index
            return

        self.start_player(current_loop_file())
        self.seek_video_to_elapsed(self.elapsed_seconds())

    def handle_commands(self) -> None:
        command = read_json(PLAYER_COMMAND_PATH)
        if not command:
            return

        action = command.get("action")
        if action == "reload":
            command_id = str(command.get("commandId") or command.get("ts") or utc_now_iso())
            loop_id = command.get("loopId")
            self.reload_manifest_schedule()
            self.loop_started_monotonic = time.monotonic()
            self.mode = VIDEO_MODE
            self.last_silent_slot_index = None
            switched = self.load_file(current_loop_file())
            self.reset_schedule_cursor(0.0)
            self.write_state(
                "playing" if switched else "error",
                0.0,
                loop_id,
                mode=self.mode,
                activeMediaPath=self.get_mpv_property("path"),
                lastHandledAction=action,
                lastHandledAt=utc_now_iso(),
                lastHandledCommandId=command_id,
                lastHandledLoopId=loop_id,
                lastHandledOk=switched,
            )

        PLAYER_COMMAND_PATH.unlink(missing_ok=True)

    def load_file(self, media_path: Path) -> bool:
        if not self.send_mpv_command({"command": ["loadfile", str(media_path), "replace"]}):
            self.logger.warning("mpv IPC unavailable, restarting process")
            self.start_player(media_path)
        return self.wait_for_media_path(media_path)

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

    def get_time_pos_seconds(self) -> float | None:
        value = self.get_mpv_property("time-pos")
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def wait_for_media_path(self, media_path: Path) -> bool:
        target_path = str(media_path)
        deadline = time.monotonic() + LOAD_CONFIRMATION_TIMEOUT_SECONDS

        while time.monotonic() < deadline:
            active_path = self.get_mpv_property("path")
            if active_path == target_path:
                return True
            time.sleep(0.5)

        self.logger.error("mpv did not confirm load for %s within %ss", media_path, LOAD_CONFIRMATION_TIMEOUT_SECONDS)
        return False

    def current_loop_duration_seconds(self) -> float:
        manifest = read_json(current_manifest_path(), {})
        duration_ms = manifest.get("totalDurationMs")
        try:
            duration_seconds = float(duration_ms) / 1000.0
            if duration_seconds > 0:
                return duration_seconds
        except (TypeError, ValueError):
            pass
        return 600.0

    def elapsed_seconds(self) -> float:
        duration_seconds = self.current_loop_duration_seconds()
        return (time.monotonic() - self.loop_started_monotonic) % duration_seconds

    def current_slot_index(self) -> int:
        return int(self.elapsed_seconds() // 60) % 10

    def static_path_for_slot(self, slot_index: int) -> Path:
        path = slot_static_path(slot_index)
        if path.exists():
            return path
        return DEFAULT_STATIC_IMAGE_PATH

    def switch_to_silent_mode(self) -> None:
        slot_index = self.current_slot_index()
        static_path = self.static_path_for_slot(slot_index)
        switched = self.load_file(static_path)
        if not switched:
            self.logger.error("failed to switch to silent mode for slot %s", slot_index)
            return

        self.mode = SILENT_MODE
        self.last_silent_slot_index = slot_index
        self.write_state(
            "silent",
            self.elapsed_seconds(),
            read_json(current_manifest_path(), {}).get("loopId"),
            mode=self.mode,
            silentSlotIndex=slot_index,
            activeMediaPath=str(static_path),
        )

    def switch_to_video_mode(self) -> None:
        elapsed = self.elapsed_seconds()
        switched = self.load_file(current_loop_file())
        if not switched:
            self.logger.error("failed to switch back to video mode")
            return

        self.seek_video_to_elapsed(elapsed)
        self.mode = VIDEO_MODE
        self.last_silent_slot_index = None
        self.reset_schedule_cursor(elapsed * 1000)
        self.write_state(
            "playing",
            elapsed,
            read_json(current_manifest_path(), {}).get("loopId"),
            mode=self.mode,
            activeMediaPath=str(current_loop_file()),
        )

    def seek_video_to_elapsed(self, elapsed_seconds: float) -> None:
        self.send_mpv_command({"command": ["seek", max(elapsed_seconds, 0.0), "absolute", "exact"]})
        self.last_position_ms = elapsed_seconds * 1000

    def sync_silent_mode_display(self) -> None:
        slot_index = self.current_slot_index()
        if slot_index == self.last_silent_slot_index:
            self.write_state(
                "silent",
                self.elapsed_seconds(),
                read_json(current_manifest_path(), {}).get("loopId"),
                mode=self.mode,
                silentSlotIndex=slot_index,
                activeMediaPath=str(self.static_path_for_slot(slot_index)),
            )
            return

        static_path = self.static_path_for_slot(slot_index)
        if self.load_file(static_path):
            self.last_silent_slot_index = slot_index
            self.write_state(
                "silent",
                self.elapsed_seconds(),
                read_json(current_manifest_path(), {}).get("loopId"),
                mode=self.mode,
                silentSlotIndex=slot_index,
                activeMediaPath=str(static_path),
            )

    def poll_playback(self) -> None:
        manifest = read_json(current_manifest_path(), {})

        if self.mode == SILENT_MODE:
            self.write_state(
                "silent",
                self.elapsed_seconds(),
                manifest.get("loopId"),
                mode=self.mode,
                silentSlotIndex=self.current_slot_index(),
                activeMediaPath=str(self.static_path_for_slot(self.current_slot_index())),
            )
            return

        time_pos_seconds = self.get_time_pos_seconds()
        active_media_path = self.get_mpv_property("path")
        if time_pos_seconds is None:
            self.write_state("error", 0.0, manifest.get("loopId"), mode=self.mode, activeMediaPath=active_media_path)
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

        self.write_state(
            "playing",
            time_pos_seconds,
            manifest.get("loopId"),
            mode=self.mode,
            activeMediaPath=active_media_path,
        )

    def reset_schedule_cursor(self, time_pos_ms: float) -> None:
        self.last_position_ms = time_pos_ms
        self.next_event_index = 0
        while self.next_event_index < len(self.schedule):
            if self.schedule[self.next_event_index]["absoluteStartMs"] > time_pos_ms:
                break
            self.next_event_index += 1

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
        self.reset_schedule_cursor(0.0)

    def write_state(
        self,
        status: str,
        time_pos_seconds: float,
        loop_id: str | None = None,
        **extra: Any,
    ) -> None:
        current_state = read_json(PLAYER_STATE_PATH, {})
        atomic_write_json(
            PLAYER_STATE_PATH,
            {
                **current_state,
                "status": status,
                "timePosSeconds": time_pos_seconds,
                "loopId": loop_id,
                "updatedAt": utc_now_iso(),
                **extra,
            },
        )

    def request_reboot(self) -> None:
        self.logger.error("mpv failed repeatedly, requesting reboot")
        subprocess.run(["systemctl", "reboot"], check=False)


if __name__ == "__main__":
    PlayerManager().run()
