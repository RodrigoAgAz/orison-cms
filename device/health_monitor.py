#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import subprocess
import termios
import time
from pathlib import Path

import psutil
import requests

from common import (
    BASE_DIR,
    LAST_LOCATION_PATH,
    PLAYBACK_LOG_PATH,
    PLAYER_STATE_PATH,
    atomic_write_json,
    build_headers,
    current_manifest_path,
    ensure_directories,
    load_config,
    read_json,
    read_jsonl,
    rewrite_jsonl,
    setup_logger,
)
from modem import GpsReader, build_gps_location, parse_qeng_serving_cell
from sync_signal import SyncRequester, decide_sync_reasons


FIRMWARE_VERSION = "1.1.0"  # keep in sync with device/VERSION

AT_PORT_CANDIDATES = [
    Path("/dev/ttyUSB2"),
    Path("/dev/ttyUSB1"),
    Path("/dev/ttyUSB0"),
    Path("/dev/serial0"),
]


class HealthMonitor:
    def __init__(self) -> None:
        self.config = load_config()
        self.logger = setup_logger("orison-health", "health.log")
        self.session = requests.Session()
        self.last_log_upload_at = 0.0
        self.at_port: Path | None = None
        self.sync_requester = SyncRequester()
        self.gps = GpsReader(
            at=self.gps_at,
            enabled=self.config.gps_enabled,
            logger=self.logger,
        )

    def run(self) -> None:
        ensure_directories()
        heartbeat_interval = int(self.config.raw["health"]["heartbeatIntervalSeconds"])
        upload_interval = int(self.config.raw["health"]["logUploadIntervalSeconds"])

        while True:
            try:
                self.send_heartbeat()
                if (
                    time.time() - self.last_log_upload_at > upload_interval
                    or len(read_jsonl(PLAYBACK_LOG_PATH)) >= 500
                ):
                    self.upload_logs()
                time.sleep(heartbeat_interval)
            except Exception as error:  # noqa: BLE001
                self.logger.exception("health monitor cycle failed: %s", error)
                time.sleep(30)

    def send_heartbeat(self) -> None:
        manifest = read_json(current_manifest_path(), {})
        player_state = read_json(PLAYER_STATE_PATH, {})
        location = self.current_location()
        self.write_runtime_location(location)

        payload = {
            "serialNumber": self.config.serial_number,
            "ipAddress": self.current_ip(),
            "firmwareVersion": self.firmware_version(),
            "storageFreeMb": int(shutil.disk_usage(BASE_DIR).free / (1024 * 1024)),
            "currentLoopId": manifest.get("loopId"),
            "cpuTemp": self.cpu_temp_c(),
            "uptimeSeconds": int(time.time() - psutil.boot_time()),
            "memoryUsedPercent": psutil.virtual_memory().percent,
            "playerStatus": player_state.get("status", "unknown"),
            "networkType": "4g",
            "signalStrength": self.extract_signal_strength(location),
            "location": location,
        }

        response = self.session.post(
            f"{self.config.api_base_url}/devices/heartbeat",
            headers=build_headers(self.config),
            data=json.dumps(payload),
            timeout=30,
        )
        response.raise_for_status()
        self.logger.info("heartbeat sent")
        try:
            body = response.json()
        except ValueError:
            body = None
        self.request_sync_if_needed(body)

    def request_sync_if_needed(self, body: object) -> bool:
        """Compare the server's expectations with local state; ask sync_agent to sync now if they differ."""
        manifest = read_json(current_manifest_path(), {}) or {}
        player_state = read_json(PLAYER_STATE_PATH, {}) or {}
        local_disabled = player_state.get("disabled")
        reasons = decide_sync_reasons(
            body,
            manifest.get("loopId"),
            manifest.get("checksum"),
            local_disabled if isinstance(local_disabled, bool) else None,
        )
        if not reasons:
            return False
        expected = {k: body.get(k) for k in ("expectedLoopId", "expectedChecksum", "disabled")}
        written = self.sync_requester.maybe_request(reasons, expected)
        if written:
            self.logger.info("requested immediate sync: %s", ",".join(reasons))
        return written

    def upload_logs(self) -> None:
        items = read_jsonl(PLAYBACK_LOG_PATH)
        if not items:
            return

        batch = items[:500]
        response = self.session.post(
            f"{self.config.api_base_url}/devices/playback-log",
            headers=build_headers(self.config),
            data=json.dumps(
                {
                    "serialNumber": self.config.serial_number,
                    "logs": batch,
                }
            ),
            timeout=30,
        )
        response.raise_for_status()

        rewrite_jsonl(PLAYBACK_LOG_PATH, items[500:])
        self.last_log_upload_at = time.time()
        self.logger.info("uploaded %s playback log entries", len(batch))

    def current_ip(self) -> str | None:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(("8.8.8.8", 80))
                return sock.getsockname()[0]
        except OSError:
            return None

    def cpu_temp_c(self) -> float | None:
        temp_path = Path("/sys/class/thermal/thermal_zone0/temp")
        if not temp_path.exists():
            return None
        try:
            return round(int(temp_path.read_text(encoding="utf-8").strip()) / 1000, 1)
        except ValueError:
            return None

    def firmware_version(self) -> str:
        version_path = BASE_DIR / "VERSION"
        if version_path.exists():
            return version_path.read_text(encoding="utf-8").strip()
        return FIRMWARE_VERSION

    def write_runtime_location(self, location: dict | None) -> None:
        if location is None:
            LAST_LOCATION_PATH.unlink(missing_ok=True)
            return

        atomic_write_json(LAST_LOCATION_PATH, location)

    def extract_signal_strength(self, location: dict | None) -> int | None:
        if not location:
            return None

        value = location.get("signalStrength")
        if isinstance(value, (int, float)):
            return int(value)
        return None

    def current_location(self) -> dict | None:
        if platform.system() == "Darwin":
            return None

        cell = self.location_via_serial()
        fix = self.gps.read() if self.at_port is not None else None
        if fix:
            return build_gps_location(fix, cell)
        return cell or self.location_via_nmcli()

    def location_via_serial(self) -> dict | None:
        candidates = list(AT_PORT_CANDIDATES)
        if self.at_port in candidates:
            candidates.remove(self.at_port)
            candidates.insert(0, self.at_port)

        for port in candidates:
            if not port.exists():
                continue

            response = self.run_at_command(port, 'AT+QENG="servingcell"')
            if "OK" in response or "+QENG" in response:
                self.at_port = port  # this is the AT port (also used for GNSS), even if SEARCHing
            parsed = self.parse_qeng_serving_cell(response)
            if parsed:
                return parsed
            if self.at_port == port:
                break

        return None

    def gps_at(self, command: str, timeout_s: float) -> str:
        if self.at_port is None:
            return ""
        return self.run_at_command(self.at_port, command, timeout_s)

    def run_at_command(self, port: Path, command: str, timeout_s: float = 1.5) -> str:
        try:
            fd = os.open(str(port), os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError:
            return ""
        try:
            attrs = termios.tcgetattr(fd)
            attrs[0] = 0
            attrs[1] = 0
            attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            attrs[3] = 0
            attrs[4] = termios.B115200
            attrs[5] = termios.B115200
            termios.tcsetattr(fd, termios.TCSANOW, attrs)

            os.write(fd, b"\r")
            time.sleep(0.05)
            try:
                os.read(fd, 4096)
            except BlockingIOError:
                pass

            os.write(fd, f"{command}\r".encode("utf-8"))

            chunks: list[bytes] = []
            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                try:
                    chunk = os.read(fd, 4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    tail = b"".join(chunks)
                    # Final result code reached: stop waiting instead of burning the full timeout.
                    if re.search(rb"(^|\r\n)(OK|ERROR|\+CME ERROR:[^\r\n]*)\r\n", tail):
                        break
                except BlockingIOError:
                    time.sleep(0.03)

            return b"".join(chunks).decode("utf-8", errors="ignore")
        except OSError:
            return ""
        finally:
            os.close(fd)

    def parse_qeng_serving_cell(self, response: str) -> dict | None:
        return parse_qeng_serving_cell(response)

    def location_via_nmcli(self) -> dict | None:
        if not shutil.which("nmcli"):
            return None

        try:
            result = subprocess.run(
                [
                    "nmcli",
                    "-t",
                    "-f",
                    "WWAN.OPERATOR,WWAN.SIGNAL,GENERAL.TYPE,GENERAL.STATE",
                    "device",
                    "show",
                ],
                capture_output=True,
                check=False,
                text=True,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None

        if result.returncode != 0:
            return None

        payload: dict[str, str] = {}
        for line in result.stdout.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            payload[key.strip()] = value.strip()

        if not payload:
            return None

        signal_strength = None
        raw_signal = payload.get("WWAN.SIGNAL")
        if raw_signal and raw_signal.lstrip("-").isdigit():
            signal_strength = int(raw_signal)

        return {
            "method": "network_manager",
            "operator": payload.get("WWAN.OPERATOR"),
            "signalStrength": signal_strength,
            "state": payload.get("GENERAL.STATE"),
            "networkType": payload.get("GENERAL.TYPE"),
        }


if __name__ == "__main__":
    HealthMonitor().run()
