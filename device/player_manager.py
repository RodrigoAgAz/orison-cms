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
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from common import (
    DEFAULT_STATIC_IMAGE_PATH,
    LAST_LOCATION_PATH,
    PLAYER_COMMAND_PATH,
    PLAYER_STATE_PATH,
    PLAYBACK_LOG_PATH,
    append_jsonl,
    atomic_write_json,
    copy_fallback_to_current,
    current_loop_file,
    current_manifest_path,
    current_safety_file,
    current_safety_image_file,
    ensure_directories,
    load_config,
    read_json,
    setup_logger,
    slot_static_path,
    utc_now_iso,
)


MPV_SOCKET_PATH = "/tmp/mpv-socket"
LOAD_CONFIRMATION_TIMEOUT_SECONDS = 15
PASSENGER_BUTTON_PIN = 17
DOOR_SENSOR_PIN = 18
DRIVER_OVERRIDE_PIN = 27
WIND_DOWN_SECONDS = 5


class PlayerState(Enum):
    IDLE = "IDLE"
    SAFETY = "SAFETY"
    JOURNEY = "JOURNEY"
    SILENT = "SILENT"
    WIND_DOWN = "WIND_DOWN"
    DISABLED = "DISABLED"


class PlayerManager:
    def __init__(self) -> None:
        self.config = load_config()
        self.logger = setup_logger("orison-player", "player.log")
        self.process: subprocess.Popen[str] | None = None
        self.schedule: list[dict[str, Any]] = []
        self.state = PlayerState.IDLE
        self.lock = threading.RLock()
        self.gpio = None
        self.loop_started_monotonic: float | None = None
        self.idle_started_monotonic = time.monotonic()
        self.wind_down_started_monotonic: float | None = None
        self.safety_started_monotonic: float | None = None
        self.journey_id: str | None = None
        self.journey_started_at_iso: str | None = None
        self.last_silent_slot_index: int | None = None
        self.last_idle_slot_index: int | None = None
        self.next_event_index = 0
        self.last_journey_position_ms = 0.0
        self.consecutive_failures = 0
        self.disabled_reason: str | None = None
        self.remote_disabled = False
        self.last_static_log_marker: tuple[str, int] | None = None

    def run(self) -> None:
        ensure_directories()
        if not current_loop_file().exists():
            copy_fallback_to_current(self.config)

        self.reload_manifest_schedule()
        self.start_player(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)
        self.start_input_listeners()
        self.transition(PlayerState.IDLE, reset_idle_clock=True)

        while True:
            try:
                if self.process and self.process.poll() is not None:
                    self.logger.warning("mpv exited unexpectedly with code %s", self.process.returncode)
                    self.consecutive_failures += 1
                    if self.consecutive_failures >= 10:
                        self.request_reboot()
                    self.restore_current_state_media()

                self.handle_commands()
                self.tick()
                time.sleep(1)
            except Exception as error:  # noqa: BLE001
                self.logger.exception("player loop error: %s", error)
                time.sleep(2)

    def start_input_listeners(self) -> None:
        self.configure_gpio_buttons()
        self.configure_keyboard_listener()

    def configure_gpio_buttons(self) -> None:
        try:
            import RPi.GPIO as gpio  # type: ignore[import-not-found]
        except Exception:
            self.logger.info("RPi.GPIO unavailable, GPIO inputs disabled")
            return

        self.gpio = gpio
        try:
            gpio.setmode(gpio.BCM)
            gpio.setup(PASSENGER_BUTTON_PIN, gpio.IN, pull_up_down=gpio.PUD_UP)
            gpio.setup(DOOR_SENSOR_PIN, gpio.IN, pull_up_down=gpio.PUD_UP)
            gpio.setup(DRIVER_OVERRIDE_PIN, gpio.IN, pull_up_down=gpio.PUD_UP)
            gpio.add_event_detect(
                PASSENGER_BUTTON_PIN,
                gpio.FALLING,
                callback=self.on_passenger_button,
                bouncetime=350,
            )
            gpio.add_event_detect(
                DOOR_SENSOR_PIN,
                gpio.FALLING,
                callback=self.on_door_sensor,
                bouncetime=350,
            )
            gpio.add_event_detect(
                DRIVER_OVERRIDE_PIN,
                gpio.FALLING,
                callback=self.on_driver_override,
                bouncetime=350,
            )
            self.logger.info(
                "configured GPIO buttons mute=%s door=%s override=%s",
                PASSENGER_BUTTON_PIN,
                DOOR_SENSOR_PIN,
                DRIVER_OVERRIDE_PIN,
            )
        except Exception as error:  # noqa: BLE001
            self.logger.warning("failed to configure GPIO inputs: %s", error)

    def configure_keyboard_listener(self) -> None:
        if not sys.stdin.isatty():
            self.logger.info("stdin is not interactive, keyboard fallback disabled")
            return

        thread = threading.Thread(target=self.keyboard_loop, daemon=True, name="keyboard-controls")
        thread.start()
        self.logger.info("configured keyboard fallback: space mute, j journey, d driver override")

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
                    self.on_passenger_button()
                elif key.lower() == "j":
                    self.on_door_sensor()
                elif key.lower() == "d":
                    self.on_driver_override()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, previous_settings)

    def on_passenger_button(self, _channel: Any = None) -> None:
        with self.lock:
            if self.state == PlayerState.JOURNEY:
                self.transition(PlayerState.SILENT)
            elif self.state == PlayerState.SILENT:
                self.transition(PlayerState.JOURNEY)

    def on_door_sensor(self, _channel: Any = None) -> None:
        with self.lock:
            if self.state == PlayerState.DISABLED:
                return

            if self.state == PlayerState.IDLE:
                self.start_journey()
                return

            self.end_journey()

    def on_driver_override(self, _channel: Any = None) -> None:
        with self.lock:
            if self.state in {PlayerState.SAFETY, PlayerState.DISABLED, PlayerState.IDLE}:
                return
            self.end_journey()

    def start_journey(self) -> None:
        if self.remote_disabled:
            self.transition(PlayerState.DISABLED)
            return

        timestamp = datetime.now(timezone.utc)
        self.journey_id = timestamp.strftime("j-%Y-%m-%d-%H%M%S")
        self.journey_started_at_iso = timestamp.isoformat().replace("+00:00", "Z")
        self.log_event(
            event="JOURNEY_START",
            state=PlayerState.IDLE,
            mode="idle",
            duration_ms=0,
            completed=True,
        )
        self.transition(PlayerState.SAFETY)

    def end_journey(self) -> None:
        if self.journey_id:
            duration_ms = self.current_journey_duration_ms()
            self.log_event(
                event="JOURNEY_END",
                state=self.state,
                mode=self.mode_name_for_state(self.state),
                duration_ms=duration_ms,
                completed=True,
            )

        if self.state == PlayerState.SAFETY:
            self.reset_journey_clock()
            self.transition(PlayerState.IDLE, reset_idle_clock=True)
            return

        self.transition(PlayerState.WIND_DOWN)

    def transition(self, new_state: PlayerState, *, reset_idle_clock: bool = False) -> None:
        old_state = self.state
        self.state = new_state
        self.logger.info("state transition %s -> %s", old_state.value, new_state.value)
        if new_state != PlayerState.SAFETY:
            self.safety_started_monotonic = None

        if new_state == PlayerState.IDLE:
            self.reset_journey_clock()
            if reset_idle_clock:
                self.idle_started_monotonic = time.monotonic()
            self.last_idle_slot_index = None
            self.last_static_log_marker = None
            self.show_idle_slot(force_reload=True)
            return

        if new_state == PlayerState.SAFETY:
            safety_path = self.current_safety_path()
            if not safety_path.exists():
                self.loop_started_monotonic = time.monotonic()
                self.transition(PlayerState.JOURNEY)
                return

            self.safety_started_monotonic = time.monotonic()
            self.load_file(safety_path, loop_forever=False)
            self.log_event(
                event=None,
                playback_type="SAFETY_MESSAGE",
                state=PlayerState.SAFETY,
                mode="journey",
                duration_ms=self.safety_duration_ms(),
                completed=True,
            )
            return

        if new_state == PlayerState.JOURNEY:
            if self.loop_started_monotonic is None:
                self.loop_started_monotonic = time.monotonic()

            elapsed = self.journey_elapsed_seconds() % self.current_loop_duration_seconds()
            self.load_file(current_loop_file(), loop_forever=True)
            self.seek_video_to_elapsed(elapsed)
            self.reset_schedule_cursor(elapsed * 1000)
            self.last_silent_slot_index = None
            return

        if new_state == PlayerState.SILENT:
            if self.loop_started_monotonic is None:
                self.loop_started_monotonic = time.monotonic()
            self.last_silent_slot_index = None
            self.last_static_log_marker = None
            self.show_silent_slot(force_reload=True)
            return

        if new_state == PlayerState.WIND_DOWN:
            self.wind_down_started_monotonic = time.monotonic()
            self.load_file(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)
            return

        if new_state == PlayerState.DISABLED:
            self.reset_journey_clock()
            self.load_file(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)

    def tick(self) -> None:
        with self.lock:
            if self.state == PlayerState.IDLE:
                self.show_idle_slot()
                self.write_state("idle", 0.0)
                return

            if self.state == PlayerState.SAFETY:
                self.write_state("playing", self.get_time_pos_seconds() or 0.0)
                if self.safety_finished():
                    self.loop_started_monotonic = time.monotonic()
                    self.transition(PlayerState.JOURNEY)
                return

            if self.state == PlayerState.JOURNEY:
                self.poll_journey_playback()
                return

            if self.state == PlayerState.SILENT:
                self.show_silent_slot()
                self.write_state("silent", self.journey_elapsed_seconds())
                return

            if self.state == PlayerState.WIND_DOWN:
                self.write_state("idle", 0.0)
                if self.wind_down_started_monotonic and time.monotonic() - self.wind_down_started_monotonic >= WIND_DOWN_SECONDS:
                    self.transition(PlayerState.IDLE, reset_idle_clock=True)
                return

            if self.state == PlayerState.DISABLED:
                self.write_state("disabled", 0.0)

    def handle_commands(self) -> None:
        command = read_json(PLAYER_COMMAND_PATH)
        if not command:
            return

        command_id = str(command.get("commandId") or command.get("ts") or utc_now_iso())
        action = command.get("action")
        loop_id = command.get("loopId")
        handled_ok = False

        try:
            if action == "reload":
                self.reload_manifest_schedule()
                self.remote_disabled = bool(command.get("disabled"))
                self.disabled_reason = command.get("disabledReason")

                if self.remote_disabled:
                    self.transition(PlayerState.DISABLED)
                elif self.state == PlayerState.DISABLED:
                    self.transition(PlayerState.IDLE, reset_idle_clock=True)
                else:
                    self.restore_current_state_media()

                handled_ok = True

            elif action == "set_disabled":
                self.remote_disabled = bool(command.get("disabled"))
                self.disabled_reason = command.get("disabledReason")

                if self.remote_disabled:
                    self.transition(PlayerState.DISABLED)
                elif self.state == PlayerState.DISABLED:
                    self.transition(PlayerState.IDLE, reset_idle_clock=True)

                handled_ok = True
        finally:
            PLAYER_COMMAND_PATH.unlink(missing_ok=True)
            self.write_state(
                self.status_name_for_state(self.state),
                self.current_time_position_seconds(),
                lastHandledAction=action,
                lastHandledAt=utc_now_iso(),
                lastHandledCommandId=command_id,
                lastHandledLoopId=loop_id,
                lastHandledOk=handled_ok,
            )

    def restore_current_state_media(self) -> None:
        if self.state == PlayerState.IDLE:
            self.show_idle_slot(force_reload=True)
            return

        if self.state == PlayerState.SAFETY:
            safety_path = self.current_safety_path()
            if safety_path.exists():
                self.load_file(safety_path, loop_forever=False)
            else:
                self.transition(PlayerState.JOURNEY)
            return

        if self.state == PlayerState.JOURNEY:
            elapsed = self.journey_elapsed_seconds() % self.current_loop_duration_seconds()
            self.load_file(current_loop_file(), loop_forever=True)
            self.seek_video_to_elapsed(elapsed)
            self.reset_schedule_cursor(elapsed * 1000)
            return

        if self.state == PlayerState.SILENT:
            self.show_silent_slot(force_reload=True)
            return

        if self.state == PlayerState.WIND_DOWN:
            self.load_file(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)
            return

        if self.state == PlayerState.DISABLED:
            self.load_file(DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)

    def start_player(self, media_path: Path, *, loop_forever: bool) -> None:
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
            f"--loop-file={'inf' if loop_forever else 'no'}",
            "--image-display-duration=inf",
            "--keep-open=yes",
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

    def load_file(self, media_path: Path, *, loop_forever: bool = False) -> bool:
        if not self.send_mpv_command({"command": ["set_property", "loop-file", "inf" if loop_forever else "no"]}):
            self.start_player(media_path, loop_forever=loop_forever)
            return self.wait_for_media_path(media_path)

        if not self.send_mpv_command({"command": ["loadfile", str(media_path), "replace"]}):
            self.start_player(media_path, loop_forever=loop_forever)
            return self.wait_for_media_path(media_path)

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

    def safety_finished(self) -> bool:
        if self.safety_is_image():
            if self.safety_started_monotonic is None:
                return False
            return time.monotonic() - self.safety_started_monotonic >= self.safety_duration_ms() / 1000.0

        eof_reached = self.get_mpv_property("eof-reached")
        if eof_reached is True:
            return True

        time_pos = self.get_time_pos_seconds()
        if time_pos is None:
            return False

        return time_pos * 1000 >= max(self.safety_duration_ms() - 250, 0)

    def current_safety_path(self) -> Path:
        if self.safety_is_image():
            image_path = current_safety_image_file()
            if image_path.exists():
                return image_path
        video_path = current_safety_file()
        if video_path.exists():
            return video_path
        return current_safety_image_file()

    def safety_is_image(self) -> bool:
        manifest = read_json(current_manifest_path(), {})
        safety_video = manifest.get("safetyVideo") or {}
        return str(safety_video.get("mimeType") or "").startswith("image/")

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

    def seek_video_to_elapsed(self, elapsed_seconds: float) -> None:
        self.send_mpv_command({"command": ["seek", max(elapsed_seconds, 0.0), "absolute", "exact"]})

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
                        "durationMs": int(content.get("durationMs", 0)),
                    }
                )

        self.schedule = schedule
        self.reset_schedule_cursor(0.0)

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

    def safety_duration_ms(self) -> int:
        manifest = read_json(current_manifest_path(), {})
        safety_video = manifest.get("safetyVideo") or {}
        try:
            value = int(safety_video.get("durationMs", 0))
        except (TypeError, ValueError):
            return 0
        return max(value, 0)

    def journey_elapsed_seconds(self) -> float:
        if self.loop_started_monotonic is None:
            return 0.0
        return max(time.monotonic() - self.loop_started_monotonic, 0.0)

    def current_journey_duration_ms(self) -> int:
        return int(self.journey_elapsed_seconds() * 1000)

    def journey_slot_index(self) -> int:
        return int(self.journey_elapsed_seconds() // 60) % 10

    def idle_slot_index(self) -> int:
        return int((time.monotonic() - self.idle_started_monotonic) // 60) % 10

    def static_path_for_slot(self, slot_index: int) -> Path:
        path = slot_static_path(slot_index)
        if path.exists():
            return path
        return DEFAULT_STATIC_IMAGE_PATH

    def slot_manifest(self, slot_index: int) -> dict[str, Any]:
        manifest = read_json(current_manifest_path(), {})
        for slot in manifest.get("slots", []):
            if int(slot.get("position", 0)) == slot_index:
                return slot
        return {}

    def slot_static_asset_id(self, slot_index: int) -> str | None:
        slot_payload = self.slot_manifest(slot_index)
        asset_id = slot_payload.get("staticImageAssetId")
        if asset_id:
            return str(asset_id)

        for content in slot_payload.get("contents", []):
            if content.get("type") == "ADVERTISEMENT":
                value = content.get("assetId")
                return str(value) if value else None
        return None

    def show_idle_slot(self, *, force_reload: bool = False) -> None:
        slot_index = self.idle_slot_index()
        if force_reload or slot_index != self.last_idle_slot_index:
            self.load_file(self.static_path_for_slot(slot_index), loop_forever=False)
            self.last_idle_slot_index = slot_index
            self.log_static_slot(slot_index, mode="idle", state=PlayerState.IDLE, duration_ms=60000)

    def show_silent_slot(self, *, force_reload: bool = False) -> None:
        slot_index = self.journey_slot_index()
        if force_reload or slot_index != self.last_silent_slot_index:
            self.load_file(self.static_path_for_slot(slot_index), loop_forever=False)
            duration_ms = 60000
            if force_reload:
                duration_ms = max(int((60 - (self.journey_elapsed_seconds() % 60)) * 1000), 1000)
            self.last_silent_slot_index = slot_index
            self.log_static_slot(slot_index, mode="silent", state=PlayerState.SILENT, duration_ms=duration_ms)

    def poll_journey_playback(self) -> None:
        elapsed_ms = (self.journey_elapsed_seconds() % self.current_loop_duration_seconds()) * 1000
        if elapsed_ms + 3000 < self.last_journey_position_ms:
            self.next_event_index = 0
        self.last_journey_position_ms = elapsed_ms

        while self.next_event_index < len(self.schedule):
            event = self.schedule[self.next_event_index]
            if event["absoluteStartMs"] > elapsed_ms:
                break
            self.log_event(
                event=None,
                playback_type=event["contentType"],
                state=PlayerState.JOURNEY,
                mode="journey",
                slot_position=event["slotPosition"],
                content_type=event["contentType"],
                asset_id=event["assetId"],
                duration_ms=event["durationMs"],
                completed=True,
            )
            self.next_event_index += 1

        self.write_state("playing", self.journey_elapsed_seconds())

    def reset_schedule_cursor(self, time_pos_ms: float) -> None:
        self.last_journey_position_ms = time_pos_ms
        self.next_event_index = 0
        while self.next_event_index < len(self.schedule):
            if self.schedule[self.next_event_index]["absoluteStartMs"] > time_pos_ms:
                break
            self.next_event_index += 1

    def log_static_slot(self, slot_index: int, *, mode: str, state: PlayerState, duration_ms: int) -> None:
        marker = (mode, slot_index)
        if self.last_static_log_marker == marker:
            return

        self.last_static_log_marker = marker
        self.log_event(
            event=None,
            playback_type="ADVERTISEMENT",
            state=state,
            mode=mode,
            slot_position=slot_index,
            content_type="ADVERTISEMENT",
            asset_id=self.slot_static_asset_id(slot_index),
            duration_ms=duration_ms,
            completed=True,
        )

    def log_event(
        self,
        *,
        event: str | None,
        playback_type: str | None = None,
        state: PlayerState,
        mode: str | None,
        slot_position: int | None = None,
        content_type: str | None = None,
        asset_id: str | None = None,
        duration_ms: int | None = None,
        completed: bool,
    ) -> None:
        payload = {
            "ts": utc_now_iso(),
            "playedAt": utc_now_iso(),
            "slotPosition": slot_position,
            "contentType": content_type,
            "type": playback_type,
            "event": event,
            "assetId": asset_id,
            "mode": mode,
            "state": state.value,
            "completedFull": completed,
            "durationMs": duration_ms,
            "journeyId": self.journey_id,
            "deviceSerial": self.config.serial_number,
            "location": read_json(LAST_LOCATION_PATH, None),
        }
        append_jsonl(PLAYBACK_LOG_PATH, payload)

    def reset_journey_clock(self) -> None:
        self.loop_started_monotonic = None
        self.journey_id = None
        self.journey_started_at_iso = None
        self.last_silent_slot_index = None
        self.last_journey_position_ms = 0.0
        self.next_event_index = 0

    def current_time_position_seconds(self) -> float:
        if self.state in {PlayerState.JOURNEY, PlayerState.SILENT}:
            return self.journey_elapsed_seconds()
        value = self.get_time_pos_seconds()
        return value if value is not None else 0.0

    def mode_name_for_state(self, state: PlayerState) -> str | None:
        if state == PlayerState.JOURNEY:
            return "journey"
        if state == PlayerState.SILENT:
            return "silent"
        if state == PlayerState.IDLE:
            return "idle"
        return None

    def status_name_for_state(self, state: PlayerState) -> str:
        if state == PlayerState.SILENT:
            return "silent"
        if state == PlayerState.DISABLED:
            return "disabled"
        if state == PlayerState.IDLE:
            return "idle"
        if state == PlayerState.WIND_DOWN:
            return "idle"
        return "playing"

    def write_state(self, status: str, time_pos_seconds: float, **extra: Any) -> None:
        current_state = read_json(PLAYER_STATE_PATH, {})
        atomic_write_json(
            PLAYER_STATE_PATH,
            {
                **current_state,
                "status": status,
                "state": self.state.value,
                "mode": self.mode_name_for_state(self.state),
                "timePosSeconds": time_pos_seconds,
                "loopId": read_json(current_manifest_path(), {}).get("loopId"),
                "journeyId": self.journey_id,
                "disabled": self.remote_disabled,
                "disabledReason": self.disabled_reason,
                "updatedAt": utc_now_iso(),
                **extra,
            },
        )

    def request_reboot(self) -> None:
        self.logger.error("mpv failed repeatedly, requesting reboot")
        subprocess.run(["systemctl", "reboot"], check=False)


if __name__ == "__main__":
    PlayerManager().run()
