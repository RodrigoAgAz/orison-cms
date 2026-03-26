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
        return "1.0.0"

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

        return self.location_via_serial() or self.location_via_nmcli()

    def location_via_serial(self) -> dict | None:
        for port in AT_PORT_CANDIDATES:
            if not port.exists():
                continue

            response = self.run_at_command(port, 'AT+QENG="servingcell"')
            parsed = self.parse_qeng_serving_cell(response)
            if parsed:
                return parsed

        return None

    def run_at_command(self, port: Path, command: str) -> str:
        fd = os.open(str(port), os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
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
            time.sleep(0.1)
            try:
                os.read(fd, 4096)
            except BlockingIOError:
                pass

            os.write(fd, f"{command}\r".encode("utf-8"))
            time.sleep(0.35)

            chunks: list[bytes] = []
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                try:
                    chunk = os.read(fd, 4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                except BlockingIOError:
                    time.sleep(0.05)

            return b"".join(chunks).decode("utf-8", errors="ignore")
        except OSError:
            return ""
        finally:
            os.close(fd)

    def parse_qeng_serving_cell(self, response: str) -> dict | None:
        for raw_line in response.splitlines():
            line = raw_line.strip()
            if not line.startswith("+QENG:") or "servingcell" not in line:
                continue

            parts = [part.strip().strip('"') for part in re.findall(r'"[^"]*"|[^,]+', line)]
            if len(parts) < 8:
                continue

            numeric_tokens = [token for token in parts if re.fullmatch(r"-?\d+", token)]
            if len(numeric_tokens) < 4:
                continue

            signal_strength = None
            for token in reversed(numeric_tokens):
                value = int(token)
                if -150 <= value <= 0:
                    signal_strength = value
                    break

            return {
                "method": "cell_tower",
                "mcc": numeric_tokens[0],
                "mnc": numeric_tokens[1],
                "lac": numeric_tokens[2],
                "cellId": numeric_tokens[3],
                "signalStrength": signal_strength,
                "raw": line,
            }

        return None

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
