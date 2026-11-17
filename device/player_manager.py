#!/usr/bin/env python3
"""Player manager: drives mpv over its JSON IPC socket and writes the playback log.

States (also the `state` values the server accepts in the playback log):
  IDLE       between journeys: one still per slot of the loop, cycling
  SAFETY     the safety message, at the start of a journey (or of a cycle in `always` mode)
  JOURNEY    the loop video
  SILENT     passenger muted the screen: the still of the current slot, the loop clock runs on
  WIND_DOWN  a few seconds of the default still after a journey ends
  DISABLED   paused from the CMS: the default still

How journeys start is `playback.trigger` in config.json: `gpio` (door/button inputs), `keyboard`
(a terminal on stdin), `always` (no passenger detection: safety message, one full pass of the loop,
repeat), or `auto` (the default: gpio if it can be set up, else keyboard if stdin is a terminal,
else always).

Playback log entries are written when an item stops being on screen, with the time it was really
shown (`durationMs`) and `completedFull` true only if it ran to within 500 ms of its scheduled
length. Each entry carries an `eventId` and the `loopId` it belongs to.
"""

from __future__ import annotations

import json
import os
import select
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from common import (
    BASE_DIR,
    DEFAULT_STATIC_IMAGE_PATH,
    LAST_LOCATION_PATH,
    PLAYER_COMMAND_PATH,
    PLAYER_STATE_PATH,
    RUNTIME_DIR,
    atomic_write_json,
    copy_fallback_to_current,
    current_loop_file,
    current_manifest_path,
    ensure_directories,
    installed_safety,
    iso_from_epoch,
    load_config,
    read_json,
    read_json_dict,
    safety_file_for,
    setup_logger,
    slot_static_path,
    utc_now_iso,
)
from log_queue import PlaybackLogQueue
from sd_notify import notify


MPV_SOCKET_PATH = str(RUNTIME_DIR / "mpv.sock")
LOAD_CONFIRMATION_TIMEOUT_SECONDS = 10
IPC_TIMEOUT_SECONDS = 2.0
PASSENGER_BUTTON_PIN = 17
DOOR_SENSOR_PIN = 18
DRIVER_OVERRIDE_PIN = 27
WIND_DOWN_SECONDS = 5
MIN_LOGGED_MS = 1000  # shorter partial glimpses (rapid mute toggles) are not logged
COMPLETE_TOLERANCE_MS = 500
STILL_CHUNK_MS = 600_000  # a still with no schedule (slotless loop) is logged in 10 minute pieces
DEFAULT_SAFETY_IMAGE_MS = 8000
STATE_WRITE_INTERVAL_SECONDS = 10
DRIFT_CHECK_SECONDS = 30
DRIFT_TOLERANCE_SECONDS = 2.0
MPV_RAPID_FAILURE_SECONDS = 30
MPV_FAILURES_PER_OUTPUT = 3
MPV_FAILURES_BEFORE_EXIT = 10
MPV_RESTART_BACKOFF_MAX_SECONDS = 60
EXIT_CODE_PLAYER_FAILED = 75
BLACK_FRAME_SOURCE = "av://lavfi:color=c=black:s=1280x720"


class PlayerState(Enum):
    IDLE = "IDLE"
    SAFETY = "SAFETY"
    JOURNEY = "JOURNEY"
    SILENT = "SILENT"
    WIND_DOWN = "WIND_DOWN"
    DISABLED = "DISABLED"


class PlayerFatal(RuntimeError):
    """mpv cannot be kept running; exit so systemd restarts the service from scratch."""


# --------------------------------------------------------------------------------------------
# Timeline: what the loop contains, derived from the manifest (not assumed to be 10 x 60 s)
# --------------------------------------------------------------------------------------------


class Timeline:
    FALLBACK_TOTAL_MS = 600_000.0

    def __init__(self, manifest: dict[str, Any] | None) -> None:
        manifest = manifest if isinstance(manifest, dict) else {}
        loop_id = manifest.get("loopId")
        self.loop_id: str | None = str(loop_id) if loop_id else None
        self.checksum = manifest.get("checksum")
        total = manifest.get("totalDurationMs")
        self.total_known = False
        self.total_ms = self.FALLBACK_TOTAL_MS
        if (
            isinstance(total, (int, float))
            and not isinstance(total, bool)
            and total > 0
            and self.loop_id != "fallback"
        ):
            self.total_ms = float(total)
            self.total_known = True
        self.slots: dict[int, dict[str, Any]] = {}
        for slot in manifest.get("slots") or []:
            if not isinstance(slot, dict):
                continue
            try:
                position = int(slot.get("position", 0))
            except (TypeError, ValueError):
                continue
            if position >= 0:
                self.slots[position] = slot
        self.slot_count = (max(self.slots) + 1) if self.slots else 0
        self.items: list[dict[str, Any]] = []
        self._build()

    @property
    def signature(self) -> tuple[Any, Any]:
        return (self.loop_id, self.checksum)

    @property
    def slot_ms(self) -> float:
        return self.total_ms / self.slot_count if self.slot_count else self.total_ms

    def set_total_ms(self, total_ms: float) -> None:
        if total_ms > 0:
            self.total_ms = float(total_ms)
            self.total_known = True
            self._build()

    def _build(self) -> None:
        items: list[dict[str, Any]] = []
        if self.slot_count:
            slot_ms = self.slot_ms
            for position in sorted(self.slots):
                contents = [c for c in self.slots[position].get("contents") or [] if isinstance(c, dict)]
                for content in sorted(contents, key=lambda c: _num(c.get("startTimeMs"))):
                    duration = _num(content.get("durationMs"))
                    if duration <= 0:
                        continue
                    content_type = content.get("type") if content.get("type") in ("ADVERTISEMENT", "FILLER") else "FILLER"
                    items.append(
                        {
                            "startMs": position * slot_ms + _num(content.get("startTimeMs")),
                            "durationMs": duration,
                            "type": content_type,
                            "contentType": content_type,
                            "assetId": content.get("assetId"),
                            "slotPosition": position,
                        }
                    )
            items.sort(key=lambda item: item["startMs"])
        else:
            # A directly uploaded loop: the whole video is one item, logged once per pass.
            items.append(
                {
                    "startMs": 0.0,
                    "durationMs": self.total_ms,
                    "type": "LOOP_VIDEO",
                    "contentType": None,
                    "assetId": None,
                    "slotPosition": None,
                }
            )
        self.items = items

    def item_at(self, position_ms: float) -> tuple[int | None, bool]:
        """(index of the item playing at position, or of the next one; whether position is inside it)."""
        for index, item in enumerate(self.items):
            if item["startMs"] + item["durationMs"] > position_ms:
                return index, item["startMs"] <= position_ms
        return None, False

    def slot_still(self, slot_index: int | None) -> tuple[Path | None, str | None]:
        """(still image path, asset id of a real static creative or None). Path None = default still."""
        if slot_index is None:
            return None, None
        path = slot_static_path(slot_index)
        try:
            if path.stat().st_size > 0:
                asset = self.slots.get(slot_index, {}).get("staticImageAssetId")
                return path, (str(asset) if asset else None)
        except OSError:
            pass
        return None, None


def _num(value: Any) -> float:
    try:
        if isinstance(value, bool):
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


# --------------------------------------------------------------------------------------------
# mpv command line
# --------------------------------------------------------------------------------------------


def mpv_output_candidates(display: dict[str, Any], environ: dict[str, str] | None = None,
                          x11_socket_dir: Path = Path("/tmp/.X11-unix")) -> list[list[str]]:
    """Video output options to try, in order. `auto`: DRM straight to the screen when no desktop
    session is running (the normal case for a cab), otherwise let mpv pick; the other is tried if
    the first keeps failing."""
    env = os.environ if environ is None else environ
    video_output = str(display.get("videoOutput") or "auto").strip().lower()
    drm = ["--vo=gpu", "--gpu-context=drm"]
    connector = str(display.get("drmConnector") or "auto").strip()
    if connector and connector.lower() != "auto":
        drm.append(f"--drm-connector={connector}")
    mode = str(display.get("drmMode") or "auto").strip()
    if mode and mode.lower() != "auto":
        drm.append(f"--drm-mode={mode}")
    mpv_default: list[str] = []
    if video_output == "drm":
        return [drm]
    if video_output in ("", "auto"):
        graphical = bool(env.get("WAYLAND_DISPLAY"))
        x_display = env.get("DISPLAY", "")
        if x_display.startswith(":"):
            number = x_display[1:].split(".")[0]
            graphical = graphical or (x11_socket_dir / f"X{number}").exists()
        return [mpv_default, drm] if graphical else [drm, mpv_default]
    return [[f"--vo={video_output}"]]


def detect_drm_connectors(sysfs: Path = Path("/sys/class/drm")) -> list[dict[str, Any]]:
    """Connected display outputs as the kernel sees them (for the heartbeat and the logs)."""
    found: list[dict[str, Any]] = []
    try:
        entries = sorted(sysfs.iterdir())
    except OSError:
        return found
    for entry in entries:
        name = entry.name
        if "-" not in name or not name.startswith("card"):
            continue
        try:
            status = (entry / "status").read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if status != "connected":
            continue
        try:
            modes = (entry / "modes").read_text(encoding="utf-8").split()
        except OSError:
            modes = []
        found.append({"name": name.split("-", 1)[1], "card": name.split("-", 1)[0], "mode": modes[0] if modes else None})
    return found


# --------------------------------------------------------------------------------------------
# Player
# --------------------------------------------------------------------------------------------


class PlayerManager:
    def __init__(self, config=None, queue: PlaybackLogQueue | None = None) -> None:
        self.config = config or load_config()
        self.logger = setup_logger("orison-player", "player.log")
        self.queue = queue or PlaybackLogQueue(max_bytes=self.config.max_log_queue_bytes, logger=self.logger)
        self.process: subprocess.Popen[bytes] | None = None
        self.lock = threading.RLock()
        self.state = PlayerState.IDLE
        self.trigger = "always"
        self.gpio = None
        self.timeline = Timeline(None)
        self.loop_available = False

        now = time.monotonic()
        self.loop_started: float | None = None
        self.idle_started = now
        self.wind_down_started: float | None = None
        self.safety_started: float | None = None
        self.safety_descriptor: dict[str, Any] | None = None
        self.still_session = uuid.uuid4().hex[:8]

        self.journey_id: str | None = None
        self.journey_started: float | None = None
        self.cycle_id: str | None = None
        self.cycle_count = 0

        self.cursor: tuple[int, int] | None = None
        self.open_entry: dict[str, Any] | None = None
        self.suspended: dict[str, Any] | None = None
        self.shown_media: str | None = None
        self.last_drift_check = 0.0

        self.remote_disabled = False
        self.disabled_reason: str | None = None

        self.output_candidates = mpv_output_candidates(self.config.display)
        self.output_index = 0
        self.output_failures = 0
        self.rapid_failures = 0
        self.mpv_started_at = 0.0
        self.mpv_restart_at = 0.0
        self.mpv_down = False
        self.last_error: str | None = None
        self._ipc_seq = 0

        self.last_handled: dict[str, Any] = {}
        self._last_state_compare: Any = None
        self._last_state_write = 0.0
        self.stopping = False
        self.ready_sent = False
        self.connectors = detect_drm_connectors()

    # ---------------------------------------------------------------- main loop
    def run(self) -> None:
        ensure_directories()
        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)
        if not current_loop_file().exists():
            try:
                if not copy_fallback_to_current(self.config):
                    self.logger.warning("no content and no fallback video; showing the default still until a sync")
            except OSError as error:
                self.logger.warning("could not install fallback content: %s", error)

        self.reload_timeline()
        self.start_input_listeners()
        self.logger.info(
            "player started: trigger=%s connectors=%s outputs=%s",
            self.trigger,
            [c["name"] for c in self.connectors],
            self.output_candidates,
        )
        with self.lock:
            self.start_initial_state(time.monotonic())
            self.write_state(force=True)
        notify("READY=1")
        notify(f"STATUS=trigger {self.trigger}")
        self.ready_sent = True

        while not self.stopping:
            progressed = False
            try:
                self.step()
                progressed = True
            except PlayerFatal as error:
                self.logger.error("giving up on mpv: %s; exiting so systemd restarts the player", error)
                self.shutdown("player_failed")
                sys.exit(EXIT_CODE_PLAYER_FAILED)
            except Exception as error:  # noqa: BLE001
                self.logger.exception("player loop error: %s", error)
            if progressed:
                notify("WATCHDOG=1")  # only after an iteration that completed
            time.sleep(1 if progressed else 2)

        self.shutdown("shutdown")

    def step(self) -> None:
        with self.lock:
            now = time.monotonic()
            self.check_mpv(now)
            self.handle_commands()
            now = time.monotonic()
            if self.process is None and self.mpv_down and now >= self.mpv_restart_at:
                self.restore_current_state_media(now)
            self.tick(time.monotonic())
            self.write_state()

    def _on_signal(self, signum, _frame) -> None:
        self.logger.info("signal %s received, stopping", signum)
        self.stopping = True

    def shutdown(self, reason: str) -> None:
        """Log what is on screen as interrupted, close the journey and flush the log to disk."""
        notify("STOPPING=1")
        with self.lock:
            now = time.monotonic()
            try:
                if self.journey_id:
                    self.end_journey(now, reason)
                else:
                    self._close_all(now)
            finally:
                self.queue.flush()
                self.write_state(force=True)
                self._terminate_mpv()

    def start_initial_state(self, now: float) -> None:
        self.show_media(self.default_still(), force=True)
        if self.remote_disabled:
            self.enter_disabled(now)
        elif self.trigger == "always":
            self.start_cycle(now)
        else:
            self.enter_idle(now)

    # ---------------------------------------------------------------- inputs
    def start_input_listeners(self) -> None:
        requested = self.config.playback_trigger
        gpio_ok = False
        if requested in ("auto", "gpio", "always"):
            gpio_ok = self.configure_gpio_buttons(door=requested != "always")
        try:
            interactive = sys.stdin is not None and sys.stdin.isatty()
        except (AttributeError, ValueError, OSError):
            interactive = False

        if requested == "always":
            trigger = "always"
        elif requested == "keyboard":
            trigger = "keyboard" if interactive else "always"
        elif requested == "gpio":
            trigger = "gpio" if gpio_ok else ("keyboard" if interactive else "always")
        else:
            trigger = "gpio" if gpio_ok else ("keyboard" if interactive else "always")
        if requested not in ("auto", trigger):
            self.logger.error(
                "playback.trigger=%s is not usable on this unit (gpio=%s, terminal=%s); using %s so the screen still plays",
                requested,
                gpio_ok,
                interactive,
                trigger,
            )
        self.trigger = trigger
        if interactive:
            thread = threading.Thread(target=self.keyboard_loop, daemon=True, name="keyboard-controls")
            thread.start()
            self.logger.info("keyboard controls: space mute, j journey start/end, d driver override")

    def configure_gpio_buttons(self, *, door: bool = True) -> bool:
        try:
            import RPi.GPIO as gpio  # type: ignore[import-not-found]
        except Exception:  # noqa: BLE001
            self.logger.info("no GPIO library on this unit, GPIO inputs disabled")
            return False

        try:
            gpio.setmode(gpio.BCM)
            pins = [(PASSENGER_BUTTON_PIN, self.on_passenger_button), (DRIVER_OVERRIDE_PIN, self.on_driver_override)]
            if door:
                pins.append((DOOR_SENSOR_PIN, self.on_door_sensor))
            for pin, callback in pins:
                gpio.setup(pin, gpio.IN, pull_up_down=gpio.PUD_UP)
                gpio.add_event_detect(pin, gpio.FALLING, callback=callback, bouncetime=350)
        except Exception as error:  # noqa: BLE001
            self.logger.warning("failed to configure GPIO inputs: %s", error)
            return False
        self.gpio = gpio
        self.logger.info(
            "configured GPIO inputs mute=%s door=%s override=%s",
            PASSENGER_BUTTON_PIN,
            DOOR_SENSOR_PIN if door else "unused",
            DRIVER_OVERRIDE_PIN,
        )
        return True

    def keyboard_loop(self) -> None:
        import termios
        import tty

        fd = sys.stdin.fileno()
        previous_settings = termios.tcgetattr(fd)
        try:
            tty.setcbreak(fd)
            while not self.stopping:
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
            now = time.monotonic()
            if self.state == PlayerState.JOURNEY:
                self._suspend_open(now)
                self.state = PlayerState.SILENT
                self.still_session = uuid.uuid4().hex[:8]
                self.logger.info("muted")
                self._advance_stills(now, self.loop_started or now, "silent")
            elif self.state == PlayerState.SILENT:
                self._close_open(now)
                self.state = PlayerState.JOURNEY
                self.logger.info("unmuted")
                self._show_loop_at_position(now, force=True)
                self._resume_video(time.monotonic())

    def on_door_sensor(self, _channel: Any = None) -> None:
        with self.lock:
            if self.trigger == "always" or self.state == PlayerState.DISABLED:
                return
            now = time.monotonic()
            if self.state in (PlayerState.IDLE, PlayerState.WIND_DOWN):
                self.start_journey(now)
                return
            was_safety = self.state == PlayerState.SAFETY
            self.end_journey(now, "door")
            if was_safety:
                self.enter_idle(now)
            else:
                self.enter_wind_down(now)

    def on_driver_override(self, _channel: Any = None) -> None:
        with self.lock:
            now = time.monotonic()
            if self.state == PlayerState.DISABLED:
                return
            if self.trigger == "always":
                # No journeys to end: restart the cycle so the safety message shows now.
                self._close_all(now)
                self.start_cycle(now)
                return
            if self.state in (PlayerState.SAFETY, PlayerState.IDLE, PlayerState.WIND_DOWN):
                return
            self.end_journey(now, "override")
            self.enter_wind_down(now)

    # ---------------------------------------------------------------- transitions
    def enter_idle(self, now: float) -> None:
        self._close_all(now)
        self._log_transition(PlayerState.IDLE)
        self.state = PlayerState.IDLE
        self.loop_started = None
        self.idle_started = now
        self.still_session = uuid.uuid4().hex[:8]
        self._advance_stills(now, now, "idle")

    def enter_wind_down(self, now: float) -> None:
        self._close_all(now)
        self._log_transition(PlayerState.WIND_DOWN)
        self.state = PlayerState.WIND_DOWN
        self.loop_started = None
        self.wind_down_started = now
        self.show_media(self.default_still())

    def enter_disabled(self, now: float) -> None:
        if self.journey_id:
            self.end_journey(now, "disabled")
        self._close_all(now)
        self._log_transition(PlayerState.DISABLED)
        self.state = PlayerState.DISABLED
        self.loop_started = None
        self.show_media(self.default_still())

    def start_journey(self, now: float) -> None:
        if self.remote_disabled:
            self.enter_disabled(now)
            return
        self._close_all(now)
        stamp = datetime.now(timezone.utc)
        self.journey_id = stamp.strftime("j-%Y-%m-%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.journey_started = now
        self.write_log(
            self._entry(event="JOURNEY_START", mode="journey", state=self.state.value, duration_ms=0, completed=True,
                        played_at_mono=now),
            durable=True,
        )
        self._enter_safety_or_loop(now)

    def end_journey(self, now: float, reason: str) -> None:
        self._close_all(now)
        if not self.journey_id:
            return
        duration_ms = int(max(now - (self.journey_started or now), 0) * 1000)
        entry = self._entry(
            event="JOURNEY_END", mode="journey", state=self.state.value, duration_ms=duration_ms, completed=True,
            played_at_mono=self.journey_started or now,
        )
        entry["endReason"] = reason
        self.write_log(entry, durable=True)
        self.queue.flush()
        self.journey_id = None
        self.journey_started = None
        self.loop_started = None
        self.cursor = None

    def start_cycle(self, now: float) -> None:
        """`always` mode: begin a new cycle (safety message, if any, then one full pass)."""
        self.cycle_id = "c-" + uuid.uuid4().hex[:8]
        self.cycle_count = 0
        self._enter_safety_or_loop(now)

    def _enter_safety_or_loop(self, now: float) -> None:
        if self.trigger == "always" and self.cycle_count % self.config.always_safety_every_cycles != 0:
            self.start_loop_pass(now)
            return
        descriptor = installed_safety()
        if descriptor is None:
            self.start_loop_pass(now)
            return
        self._close_all(now)
        self._log_transition(PlayerState.SAFETY)
        self.state = PlayerState.SAFETY
        self.safety_descriptor = descriptor
        self.show_media(safety_file_for(descriptor), force=True)
        self.safety_started = time.monotonic()
        scheduled = descriptor.get("durationMs") or None
        if scheduled is None and str(descriptor.get("mimeType", "")).startswith("image/"):
            scheduled = DEFAULT_SAFETY_IMAGE_MS
        self._open_entry(
            key=("safety", self.journey_id or self.cycle_id, self.cycle_count, self.safety_started),
            kind="safety",
            at=self.safety_started,
            scheduled_ms=scheduled,
            fields={"type": "SAFETY", "contentType": None, "assetId": None, "slotPosition": None},
            end_mono=None,
            mode=self._play_mode(),
            state=PlayerState.SAFETY.value,
        )

    def start_loop_pass(self, now: float) -> None:
        """Fresh start of the loop at position 0 (journey start, or a new pass in `always` mode)."""
        self._close_all(now)
        self._log_transition(PlayerState.JOURNEY)
        self.state = PlayerState.JOURNEY
        self.cursor = (0, 0)
        if self.loop_available:
            self.show_media(current_loop_file(), loop_forever=True, force=True)
            self._learn_loop_duration()
        else:
            self.show_media(self.default_still())
        self.loop_started = time.monotonic()
        self.last_drift_check = self.loop_started
        self._advance_video(self.loop_started)

    def _log_transition(self, new_state: PlayerState) -> None:
        if new_state != self.state:
            self.logger.info("state transition %s -> %s", self.state.value, new_state.value)

    def _play_mode(self) -> str:
        return "continuous" if self.trigger == "always" else "journey"

    # ---------------------------------------------------------------- per-second tick
    def tick(self, now: float | None = None) -> None:
        with self.lock:
            now = time.monotonic() if now is None else now
            if self.mpv_down:
                return
            if self.state == PlayerState.IDLE:
                self._advance_stills(now, self.idle_started, "idle")
            elif self.state == PlayerState.SAFETY:
                finished_at = self.safety_finished_at(now)
                if finished_at is not None:
                    self._close_open(finished_at, natural=True)
                    self.start_loop_pass(now)
            elif self.state == PlayerState.JOURNEY:
                if self.loop_available:
                    if not self.timeline.total_known:
                        self._learn_loop_duration()
                    self._drift_correct(now)
                self._advance_video(now)
            elif self.state == PlayerState.SILENT:
                self._tick_silent(now)
            elif self.state == PlayerState.WIND_DOWN:
                if self.wind_down_started is not None and now - self.wind_down_started >= WIND_DOWN_SECONDS:
                    self.enter_idle(now)

    def _tick_silent(self, now: float) -> None:
        if self.suspended and self.suspended.get("end_mono") is not None and self.suspended["end_mono"] <= now:
            self._flush_suspended()
        if self.loop_started is None:
            self.loop_started = now
        if self.trigger == "always":
            total_s = self.timeline.total_ms / 1000.0
            while now - self.loop_started >= total_s:
                # A pass ends while muted: count it, carry on with the next one (the safety
                # message is not forced on a passenger who has muted the screen).
                self._close_open(self.loop_started + total_s)
                self._flush_suspended()
                self.loop_started += total_s
                self.cycle_count += 1
                self.queue.flush()
        self._advance_stills(now, self.loop_started, "silent")

    def _advance_video(self, now: float) -> None:
        if self.state != PlayerState.JOURNEY or not self.loop_available or self.loop_started is None:
            return
        items = self.timeline.items
        if not items:
            return
        if self.cursor is None:
            self._resume_video(now)
        for _ in range(10000):
            entry = self.open_entry
            assert self.cursor is not None
            if entry is not None and entry["kind"] == "video":
                end = self._item_end(*self.cursor)
                if end > now:
                    return
                self._close_open(end)
                self.cursor = self._next_cursor(self.cursor)
                if self.trigger == "always" and self.cursor[0] > 0:
                    self._on_pass_complete(end, now)
                    return
                continue
            if entry is not None:
                self._close_open(now)
            if self.trigger == "always" and self.cursor[0] > 0:
                self._on_pass_complete(self.loop_started + self.timeline.total_ms / 1000.0, now)
                return
            pass_index, index = self.cursor
            start = self._item_start(pass_index, index)
            if start > now:
                return
            self._open_video(pass_index, index, start)

    def _on_pass_complete(self, pass_end: float, now: float) -> None:
        self.cycle_count += 1
        self.queue.flush()
        due = self.cycle_count % self.config.always_safety_every_cycles == 0
        if due and installed_safety() is not None:
            self._enter_safety_or_loop(now)
            return
        # Next pass without reloading: mpv is looping the file seamlessly.
        self.loop_started = pass_end
        self.cursor = (0, 0)
        self._advance_video(now)

    def _item_start(self, pass_index: int, index: int) -> float:
        assert self.loop_started is not None
        return self.loop_started + (pass_index * self.timeline.total_ms + self.timeline.items[index]["startMs"]) / 1000.0

    def _item_end(self, pass_index: int, index: int) -> float:
        return self._item_start(pass_index, index) + self.timeline.items[index]["durationMs"] / 1000.0

    def _next_cursor(self, cursor: tuple[int, int]) -> tuple[int, int]:
        pass_index, index = cursor
        if index + 1 < len(self.timeline.items):
            return pass_index, index + 1
        return pass_index + 1, 0

    def _video_key(self, pass_index: int, index: int) -> tuple[Any, ...]:
        return ("video", self.journey_id or self.cycle_id, self.cycle_count, pass_index, index)

    def _open_video(self, pass_index: int, index: int, at: float) -> None:
        item = self.timeline.items[index]
        self._open_entry(
            key=self._video_key(pass_index, index),
            kind="video",
            at=at,
            scheduled_ms=item["durationMs"],
            fields={
                "type": item["type"],
                "contentType": item["contentType"],
                "assetId": item["assetId"],
                "slotPosition": item["slotPosition"],
            },
            end_mono=self._item_end(pass_index, index),
            mode=self._play_mode(),
            state=PlayerState.JOURNEY.value,
        )

    def _resume_video(self, now: float) -> None:
        """Pick the loop up mid-way (unmute, mpv restart, reload). The item on screen continues the
        entry it had before the interruption, or starts a partial one: never a new full play."""
        if self.loop_started is None or not self.timeline.items:
            return
        elapsed_ms = (now - self.loop_started) * 1000.0
        total = self.timeline.total_ms
        pass_index = int(elapsed_ms // total)
        position = elapsed_ms - pass_index * total
        index, inside = self.timeline.item_at(position)
        if index is None:
            self.cursor = (pass_index + 1, 0)
        else:
            self.cursor = (pass_index, index)
            if inside:
                self._open_video(pass_index, index, now)
        self._advance_video(now)

    def _advance_stills(self, now: float, origin: float, mode: str) -> None:
        state = PlayerState.SILENT.value if mode == "silent" else PlayerState.IDLE.value
        timeline = self.timeline
        period_ms = timeline.slot_ms if timeline.slot_count else STILL_CHUNK_MS
        for _ in range(1000):
            entry = self.open_entry
            if entry is not None and entry["kind"] == "still":
                if entry["end_mono"] > now:
                    return
                at = entry["end_mono"]
                self._close_open(at, natural=True)
            else:
                if entry is not None:
                    self._close_open(now)
                at = now
            period = int(((at - origin) * 1000.0 + 0.5) // period_ms)
            period_end = origin + (period + 1) * period_ms / 1000.0
            if timeline.slot_count:
                slot = period % timeline.slot_count
                path, asset = timeline.slot_still(slot)
                scheduled: float | None = period_ms
            else:
                slot, path, asset, scheduled = None, None, None, None
            self.show_media(path or self.default_still())
            self._open_entry(
                key=("still", mode, self.still_session, period),
                kind="still",
                at=at,
                scheduled_ms=scheduled,
                fields={"type": "STATIC_IMAGE", "contentType": None, "assetId": asset, "slotPosition": slot},
                end_mono=period_end,
                mode=mode,
                state=state,
            )

    def safety_finished_at(self, now: float) -> float | None:
        started = self.safety_started if self.safety_started is not None else now
        descriptor = self.safety_descriptor or {}
        duration_s = (descriptor.get("durationMs") or 0) / 1000.0
        if str(descriptor.get("mimeType", "")).startswith("image/"):
            duration_s = duration_s or DEFAULT_SAFETY_IMAGE_MS / 1000.0
            return started + duration_s if now - started >= duration_s else None
        if self.get_mpv_property("eof-reached") is True:
            return min(now, started + duration_s) if duration_s else now
        if not duration_s:
            value = self.get_mpv_property("duration")
            duration_s = float(value) if isinstance(value, (int, float)) and value > 0 else 0.0
        time_pos = self.get_time_pos_seconds()
        if duration_s and time_pos is not None and time_pos >= duration_s - 0.25:
            return min(now, started + duration_s)
        # mpv never reported the end (stalled, or a file it cannot read): do not hang the journey.
        limit = (duration_s or 120.0) + 15.0
        if now - started >= limit:
            self.logger.warning("safety message did not report its end after %.0fs, moving on", now - started)
            return now
        return None

    def _learn_loop_duration(self) -> None:
        value = self.get_mpv_property("duration")
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            if not self.timeline.total_known:
                self.timeline.set_total_ms(value * 1000.0)

    def _drift_correct(self, now: float) -> None:
        """Keep the loop clock (which decides what is logged) aligned with what mpv shows."""
        if self.loop_started is None or now - self.last_drift_check < DRIFT_CHECK_SECONDS:
            return
        self.last_drift_check = now
        time_pos = self.get_time_pos_seconds()
        if time_pos is None:
            return
        total_s = self.timeline.total_ms / 1000.0
        expected = (now - self.loop_started) % total_s
        diff = expected - time_pos
        if diff > total_s / 2:
            diff -= total_s
        elif diff < -total_s / 2:
            diff += total_s
        if abs(diff) > DRIFT_TOLERANCE_SECONDS:
            self.logger.info("loop clock drifted %.1fs from mpv, realigning", diff)
            self.loop_started += diff

    # ---------------------------------------------------------------- playback log entries
    def _open_entry(self, *, key, kind, at, scheduled_ms, fields, end_mono, mode, state) -> None:
        if self.open_entry is not None:
            self._close_open(at)
        if self.mpv_down:
            return  # nothing is on screen; restore_current_state_media reopens it when mpv is back
        suspended = self.suspended
        if suspended is not None and suspended["key"] == key:
            self.suspended = None
            suspended["seg_start"] = at
            suspended["end_mono"] = end_mono
            self.open_entry = suspended
            return
        if suspended is not None and (kind == suspended["kind"] or suspended["kind"] != "video"):
            self._flush_suspended()
        self.open_entry = {
            "key": key,
            "kind": kind,
            "first_start": at,
            "seg_start": at,
            "acc_ms": 0.0,
            "scheduled_ms": scheduled_ms,
            "fields": fields,
            "end_mono": end_mono,
            "mode": mode,
            "state": state,
            "loop_id": self.timeline.loop_id,
            "journey_id": self.journey_id,
        }

    def _close_open(self, at: float, natural: bool | None = None) -> None:
        entry = self.open_entry
        if entry is None:
            return
        self.open_entry = None
        entry["acc_ms"] += max(at - entry["seg_start"], 0.0) * 1000.0
        self._emit(entry, natural)

    def _suspend_open(self, at: float) -> None:
        entry = self.open_entry
        if entry is None:
            return
        self.open_entry = None
        entry["acc_ms"] += max(at - entry["seg_start"], 0.0) * 1000.0
        if self.suspended is not None:
            self._emit(self.suspended, None)
        self.suspended = entry

    def _flush_suspended(self) -> None:
        if self.suspended is not None:
            entry, self.suspended = self.suspended, None
            self._emit(entry, None)

    def _close_all(self, at: float) -> None:
        self._close_open(at, natural=False)
        self._flush_suspended()

    def _emit(self, entry: dict[str, Any], natural: bool | None) -> None:
        duration = int(round(entry["acc_ms"]))
        scheduled = entry["scheduled_ms"]
        if scheduled is None:
            complete = True if natural is None else bool(natural)
            if entry["kind"] == "safety" and natural is None:
                complete = False
        else:
            complete = duration >= scheduled - COMPLETE_TOLERANCE_MS
        if duration < MIN_LOGGED_MS and not complete:
            return
        payload = self._entry(
            event=None,
            mode=entry["mode"],
            state=entry["state"],
            duration_ms=duration,
            completed=complete,
            played_at_mono=entry["first_start"],
            loop_id=entry["loop_id"],
            journey_id=entry["journey_id"],
            **entry["fields"],
        )
        self.write_log(payload)

    def _entry(self, *, event, mode, state, duration_ms, completed, played_at_mono, loop_id=None,
               journey_id=None, type=None, contentType=None, assetId=None, slotPosition=None) -> dict[str, Any]:
        played_at = iso_from_epoch(time.time() - (time.monotonic() - played_at_mono))
        return {
            "eventId": str(uuid.uuid4()),
            "loopId": loop_id if loop_id is not None else self.timeline.loop_id,
            "ts": utc_now_iso(),
            "playedAt": played_at,
            "slotPosition": slotPosition,
            "contentType": contentType,
            "type": type,
            "event": event,
            "assetId": assetId,
            "mode": mode,
            "state": state,
            "completedFull": completed,
            "durationMs": duration_ms,
            "journeyId": journey_id if journey_id is not None else self.journey_id,
            "deviceSerial": self.config.serial_number,
            "location": read_json(LAST_LOCATION_PATH, None),
        }

    def write_log(self, entry: dict[str, Any], durable: bool = False) -> None:
        try:
            self.queue.append(entry, durable=durable)
        except OSError as error:
            self.logger.error("could not write playback log entry: %s", error)

    # ---------------------------------------------------------------- commands from the sync agent
    def handle_commands(self) -> None:
        command = read_json(PLAYER_COMMAND_PATH)
        if command is None and not PLAYER_COMMAND_PATH.exists():
            return
        PLAYER_COMMAND_PATH.unlink(missing_ok=True)
        if not isinstance(command, dict):
            return

        command_id = str(command.get("commandId") or command.get("ts") or utc_now_iso())
        action = command.get("action")
        loop_id = command.get("loopId")
        handled_ok = False
        now = time.monotonic()
        try:
            if action == "reload":
                handled_ok = self.apply_reload(now)
                if "disabled" in command:
                    self.apply_disabled(bool(command.get("disabled")), command.get("disabledReason"), now)
            elif action == "set_disabled":
                self.apply_disabled(bool(command.get("disabled")), command.get("disabledReason"), now)
                handled_ok = True
        finally:
            self.last_handled = {
                "lastHandledAction": action,
                "lastHandledAt": utc_now_iso(),
                "lastHandledCommandId": command_id,
                "lastHandledLoopId": loop_id,
                "lastHandledOk": handled_ok,
            }
            self.write_state(force=True)

    def apply_disabled(self, disabled: bool, reason: Any, now: float) -> None:
        self.disabled_reason = reason if isinstance(reason, str) else None
        if disabled == self.remote_disabled and (disabled == (self.state == PlayerState.DISABLED)):
            return  # nothing changed: do not reload the screen
        self.remote_disabled = disabled
        if disabled:
            self.enter_disabled(now)
        elif self.state == PlayerState.DISABLED:
            if self.trigger == "always":
                self.start_cycle(now)
            else:
                self.enter_idle(now)

    def apply_reload(self, now: float) -> bool:
        previous = self.timeline.signature
        self.reload_timeline()
        changed = self.timeline.signature != previous
        if changed:
            self.logger.info("content changed to %s", self.timeline.loop_id)
            self._close_all(now)
            self.shown_media = None
            if self.state == PlayerState.IDLE:
                self.enter_idle(now)
            elif self.state == PlayerState.JOURNEY:
                if self.trigger == "always":
                    self.start_loop_pass(now)
                else:
                    ok = self._show_loop_at_position(now, force=True)
                    self.cursor = None
                    self._resume_video(time.monotonic())
                    if not ok:
                        return False
            elif self.state == PlayerState.SILENT:
                self.still_session = uuid.uuid4().hex[:8]
                self._advance_stills(now, self.loop_started or now, "silent")
        if not self.loop_available and self.timeline.loop_id is not None:
            self.logger.error("loop video for %s is missing or empty", self.timeline.loop_id)
            return False
        return True

    def reload_timeline(self) -> None:
        manifest = read_json_dict(current_manifest_path())
        self.timeline = Timeline(manifest)
        try:
            self.loop_available = current_loop_file().stat().st_size > 0
        except OSError:
            self.loop_available = False

    # ---------------------------------------------------------------- mpv
    def default_still(self) -> Path | str:
        for candidate in (DEFAULT_STATIC_IMAGE_PATH, BASE_DIR / DEFAULT_STATIC_IMAGE_PATH.name):
            try:
                if candidate.stat().st_size > 0:
                    return candidate
            except OSError:
                continue
        return BLACK_FRAME_SOURCE

    def show_media(self, media: Path | str, *, loop_forever: bool = False, force: bool = False) -> bool:
        target = str(media)
        if not force and self.shown_media == target and self.process is not None:
            return True
        ok = self.load_file(media, loop_forever=loop_forever)
        self.shown_media = target if ok else None
        return ok

    def _show_loop_at_position(self, now: float, *, force: bool = False) -> bool:
        if not self.loop_available:
            return self.show_media(self.default_still())
        ok = self.show_media(current_loop_file(), loop_forever=True, force=force)
        if self.loop_started is not None:
            elapsed = (time.monotonic() - self.loop_started) % (self.timeline.total_ms / 1000.0)
            self.send_mpv_command({"command": ["seek", max(elapsed, 0.0), "absolute", "exact"]})
        return ok

    def restore_current_state_media(self, now: float) -> None:
        """Put the right thing back on screen after mpv was restarted."""
        self.mpv_down = False
        self.shown_media = None
        if self.state == PlayerState.IDLE:
            self._advance_stills(now, self.idle_started, "idle")
        elif self.state == PlayerState.SAFETY:
            self._enter_safety_or_loop(now)
        elif self.state == PlayerState.JOURNEY:
            self._show_loop_at_position(now, force=True)
            self.cursor = None
            self._resume_video(time.monotonic())
        elif self.state == PlayerState.SILENT:
            self._advance_stills(now, self.loop_started or now, "silent")
        else:
            self.show_media(self.default_still(), force=True)

    def check_mpv(self, now: float) -> None:
        if self.process is None or self.process.poll() is None:
            return
        code = self.process.returncode
        ran = now - self.mpv_started_at
        self.process = None
        self._on_mpv_failure(now, f"mpv exited with code {code} after {ran:.0f}s", rapid=ran < MPV_RAPID_FAILURE_SECONDS)

    def _on_mpv_failure(self, now: float, reason: str, *, rapid: bool) -> None:
        self.logger.warning("%s", reason)
        self.last_error = reason
        # What was on screen stopped: account for it, and resume it when mpv is back.
        self._suspend_open(now)
        self.shown_media = None
        self.mpv_down = True
        if rapid:
            self.rapid_failures += 1
            self.output_failures += 1
        else:
            self.rapid_failures = 1
            self.output_failures = 1
        if self.output_failures >= MPV_FAILURES_PER_OUTPUT and self.output_index + 1 < len(self.output_candidates):
            self.output_index += 1
            self.output_failures = 0
            self.logger.warning("switching mpv video output to %s", self.output_candidates[self.output_index] or "mpv default")
        if self.rapid_failures >= MPV_FAILURES_BEFORE_EXIT:
            raise PlayerFatal(reason)
        delay = min(2 ** (self.rapid_failures - 1), MPV_RESTART_BACKOFF_MAX_SECONDS)
        self.mpv_restart_at = now + delay

    def mpv_command_line(self, media_path: Path | str, *, loop_forever: bool) -> list[str]:
        output = self.output_candidates[self.output_index] if self.output_candidates else []
        keep_aspect = "yes" if self.config.display.get("keepAspect", True) else "no"
        return [
            "mpv",
            "--fullscreen",
            f"--loop-file={'inf' if loop_forever else 'no'}",
            "--image-display-duration=inf",
            "--keep-open=yes",
            "--no-terminal",
            "--no-input-default-bindings",
            "--hwdec=auto",
            *output,
            f"--keepaspect={keep_aspect}",
            "--no-osc",
            "--no-osd-bar",
            f"--input-ipc-server={MPV_SOCKET_PATH}",
            str(media_path),
        ]

    def _terminate_mpv(self) -> None:
        process, self.process = self.process, None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=10)
        except Exception:  # noqa: BLE001 - TimeoutExpired, or anything a stub raises
            process.kill()

    def start_player(self, media_path: Path | str, *, loop_forever: bool) -> bool:
        self._terminate_mpv()
        try:
            os.unlink(MPV_SOCKET_PATH)
        except OSError:
            pass
        command = self.mpv_command_line(media_path, loop_forever=loop_forever)
        self.logger.info("starting mpv with %s", media_path)
        now = time.monotonic()
        try:
            self.process = subprocess.Popen(command)
        except OSError as error:
            self.process = None
            self._on_mpv_failure(now, f"cannot start mpv: {error}", rapid=True)
            return False
        self.mpv_started_at = now
        self.mpv_down = False
        return True

    def load_file(self, media_path: Path | str, *, loop_forever: bool = False) -> bool:
        if self.mpv_down and self.process is None and time.monotonic() < self.mpv_restart_at:
            return False
        loop_value = "inf" if loop_forever else "no"
        if self.process is None or not self.send_mpv_command({"command": ["set_property", "loop-file", loop_value]}):
            if not self.start_player(media_path, loop_forever=loop_forever):
                return False
            return self.wait_for_media_path(media_path)
        if not self.send_mpv_command({"command": ["loadfile", str(media_path), "replace"]}):
            if not self.start_player(media_path, loop_forever=loop_forever):
                return False
        return self.wait_for_media_path(media_path)

    def _ipc(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        if not os.path.exists(MPV_SOCKET_PATH):
            return None
        self._ipc_seq += 1
        request_id = self._ipc_seq
        message = {**payload, "request_id": request_id}
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(IPC_TIMEOUT_SECONDS)
                client.connect(MPV_SOCKET_PATH)
                client.sendall((json.dumps(message) + "\n").encode("utf-8"))
                buffer = b""
                deadline = time.monotonic() + IPC_TIMEOUT_SECONDS
                while True:
                    chunk = client.recv(65536)
                    if not chunk:
                        return None
                    buffer += chunk
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        try:
                            reply = json.loads(line.decode("utf-8"))
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            continue
                        # mpv broadcasts events to every client; skip them and wait for our reply.
                        if isinstance(reply, dict) and "error" in reply and "event" not in reply:
                            if reply.get("request_id", request_id) == request_id:
                                return reply
                    if time.monotonic() > deadline:
                        return None
        except OSError:
            return None

    def send_mpv_command(self, payload: dict[str, Any]) -> bool:
        reply = self._ipc(payload)
        return reply is not None

    def get_mpv_property(self, property_name: str) -> Any | None:
        reply = self._ipc({"command": ["get_property", property_name]})
        if not reply or reply.get("error") not in (None, "success"):
            return None
        return reply.get("data")

    def get_time_pos_seconds(self) -> float | None:
        value = self.get_mpv_property("time-pos")
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    def wait_for_media_path(self, media_path: Path | str) -> bool:
        target_path = str(media_path)
        deadline = time.monotonic() + LOAD_CONFIRMATION_TIMEOUT_SECONDS
        while time.monotonic() < deadline and not self.stopping:
            if self.get_mpv_property("path") == target_path:
                return True
            if self.process is not None and self.process.poll() is not None:
                return False
            time.sleep(0.5)
        self.logger.error("mpv did not confirm load for %s within %ss", media_path, LOAD_CONFIRMATION_TIMEOUT_SECONDS)
        self.last_error = f"mpv did not confirm load of {Path(target_path).name}"
        return False

    # ---------------------------------------------------------------- state file for the other services
    def status_name(self) -> str:
        if self.mpv_down:
            return "error"
        return {
            PlayerState.SILENT: "silent",
            PlayerState.DISABLED: "disabled",
            PlayerState.IDLE: "idle",
            PlayerState.WIND_DOWN: "idle",
            PlayerState.SAFETY: "playing",
            PlayerState.JOURNEY: "playing",
        }[self.state]

    def mode_name(self) -> str | None:
        if self.state in (PlayerState.JOURNEY, PlayerState.SAFETY):
            return "safety" if self.state == PlayerState.SAFETY else self._play_mode()
        if self.state == PlayerState.SILENT:
            return "silent"
        if self.state in (PlayerState.IDLE, PlayerState.WIND_DOWN):
            return "idle"
        return None

    def write_state(self, force: bool = False) -> None:
        now = time.monotonic()
        payload = {
            "status": self.status_name(),
            "state": self.state.value,
            "mode": self.mode_name(),
            "trigger": self.trigger,
            "loopId": self.timeline.loop_id,
            "journeyId": self.journey_id,
            "disabled": self.remote_disabled,
            "disabledReason": self.disabled_reason,
            "lastError": self.last_error,
            "mpvOutput": " ".join(self.output_candidates[self.output_index]) if self.output_candidates else "",
            "display": {"connectors": self.connectors},
            **self.last_handled,
        }
        if not force and payload == self._last_state_compare and now - self._last_state_write < STATE_WRITE_INTERVAL_SECONDS:
            return
        self._last_state_compare = dict(payload)
        self._last_state_write = now
        elapsed = (now - self.loop_started) if self.loop_started is not None else 0.0
        payload["timePosSeconds"] = round(max(elapsed, 0.0), 1)
        payload["updatedAt"] = utc_now_iso()
        try:
            atomic_write_json(PLAYER_STATE_PATH, payload, durable=False)
        except OSError as error:
            self.logger.warning("could not write player state: %s", error)


if __name__ == "__main__":
    PlayerManager().run()
