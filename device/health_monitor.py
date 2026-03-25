#!/usr/bin/env python3

from __future__ import annotations

import json
import shutil
import socket
import time
from pathlib import Path

import psutil
import requests

from common import (
    BASE_DIR,
    PLAYBACK_LOG_PATH,
    PLAYER_STATE_PATH,
    build_headers,
    current_manifest_path,
    ensure_directories,
    load_config,
    read_json,
    read_jsonl,
    rewrite_jsonl,
    setup_logger,
)


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
            "signalStrength": None,
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


if __name__ == "__main__":
    HealthMonitor().run()
