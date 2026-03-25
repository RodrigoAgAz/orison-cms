#!/usr/bin/env python3

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import requests

from common import (
    CURRENT_DIR,
    PREVIOUS_DIR,
    STAGING_DIR,
    build_headers,
    copy_fallback_to_current,
    current_manifest_path,
    ensure_directories,
    load_config,
    setup_logger,
    sha256_file,
    utc_now_iso,
    write_player_command,
)


class SyncAgent:
    def __init__(self) -> None:
        self.config = load_config()
        self.logger = setup_logger("orison-sync", "sync.log")
        self.session = requests.Session()

    def run(self) -> None:
        ensure_directories()
        self.ensure_boot_content()

        self.logger.info("sync agent started")
        while True:
            try:
                self.sync_once()
                interval = int(self.config.raw["sync"]["checkIntervalSeconds"])
                time.sleep(interval)
            except Exception as error:  # noqa: BLE001
                self.logger.exception("sync cycle failed: %s", error)
                time.sleep(30)

    def ensure_boot_content(self) -> None:
        if current_manifest_path().exists() and (CURRENT_DIR / "loop.mp4").exists():
            return
        copy_fallback_to_current(self.config)
        write_player_command("reload", loopId="fallback")

    def sync_once(self) -> None:
        remote = self.fetch_manifest_info()
        local = self.load_local_manifest()

        if local and local.get("loopId") == remote["loopId"] and local.get("checksum") == remote["checksum"]:
            self.logger.info("loop already current: %s", remote["loopId"])
            return

        staging_dir = self.download_loop(remote)
        self.activate(staging_dir, remote["loopId"])
        self.send_sync_heartbeat(remote["loopId"])
        self.logger.info("activated loop %s", remote["loopId"])

    def load_local_manifest(self) -> dict | None:
        try:
            with current_manifest_path().open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return None

    def fetch_manifest_info(self) -> dict:
        response = self.session.get(
            f"{self.config.api_base_url}/devices/manifest",
            headers=build_headers(self.config),
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    def download_loop(self, manifest_info: dict) -> Path:
        loop_id = manifest_info["loopId"]
        staging_dir = STAGING_DIR / loop_id
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        staging_dir.mkdir(parents=True, exist_ok=True)

        manifest_path = staging_dir / "manifest.json"
        video_path = staging_dir / "loop.mp4"
        download_limit = int(self.config.raw["sync"]["maxBandwidthBytesPerSec"])
        timeout = int(self.config.raw["sync"]["downloadTimeoutSeconds"])

        self.download_file(manifest_info["manifestUrl"], manifest_path, timeout, download_limit)

        with manifest_path.open("r", encoding="utf-8") as handle:
            manifest = json.load(handle)

        compiled_video_url = manifest.get("compiledVideoUrl") or manifest_info.get("compiledVideoUrl")
        if not compiled_video_url:
            raise RuntimeError("manifest does not contain a compiledVideoUrl")

        self.download_file(compiled_video_url, video_path, timeout, download_limit)

        expected_checksum = manifest.get("compiledVideoChecksum")
        if expected_checksum and sha256_file(video_path) != expected_checksum:
            raise RuntimeError("compiled loop checksum mismatch")

        return staging_dir

    def download_file(
        self,
        url: str,
        target_path: Path,
        timeout_seconds: int,
        max_bandwidth_bytes_per_sec: int,
    ) -> None:
        retries = int(self.config.raw["sync"].get("maxDownloadRetries", 3))
        last_error: Exception | None = None

        for attempt in range(1, retries + 1):
            try:
                part_path = target_path.with_suffix(target_path.suffix + ".part")
                downloaded = part_path.stat().st_size if part_path.exists() else 0

                headers = {}
                if downloaded > 0:
                    headers["Range"] = f"bytes={downloaded}-"

                started = time.monotonic()
                response = self.session.get(
                    url,
                    headers=headers,
                    stream=True,
                    timeout=timeout_seconds,
                )

                if downloaded > 0 and response.status_code not in (200, 206):
                    downloaded = 0
                    if part_path.exists():
                        part_path.unlink()
                    response = self.session.get(url, stream=True, timeout=timeout_seconds)

                response.raise_for_status()

                mode = "ab" if downloaded > 0 and response.status_code == 206 else "wb"
                with part_path.open(mode) as handle:
                    for chunk in response.iter_content(chunk_size=256 * 1024):
                        if not chunk:
                            continue
                        handle.write(chunk)
                        downloaded += len(chunk)

                        if max_bandwidth_bytes_per_sec > 0:
                            elapsed = max(time.monotonic() - started, 0.001)
                            allowed = elapsed * max_bandwidth_bytes_per_sec
                            if downloaded > allowed:
                                time.sleep((downloaded - allowed) / max_bandwidth_bytes_per_sec)

                part_path.replace(target_path)
                return
            except Exception as error:  # noqa: BLE001
                last_error = error
                self.logger.warning("download attempt %s failed for %s: %s", attempt, url, error)
                time.sleep(2**attempt)

        if last_error:
            raise last_error

    def activate(self, staging_dir: Path, loop_id: str) -> None:
        if PREVIOUS_DIR.exists():
            shutil.rmtree(PREVIOUS_DIR, ignore_errors=True)
        if CURRENT_DIR.exists():
            CURRENT_DIR.replace(PREVIOUS_DIR)
        staging_dir.replace(CURRENT_DIR)
        write_player_command("reload", loopId=loop_id, activatedAt=utc_now_iso())

    def send_sync_heartbeat(self, loop_id: str) -> None:
        payload = {
            "serialNumber": self.config.serial_number,
            "currentLoopId": loop_id,
            "storageFreeMb": int(shutil.disk_usage(CURRENT_DIR).free / (1024 * 1024)),
        }
        try:
            response = self.session.post(
                f"{self.config.api_base_url}/devices/heartbeat",
                headers=build_headers(self.config),
                data=json.dumps(payload),
                timeout=30,
            )
            response.raise_for_status()
        except requests.RequestException as error:
            self.logger.warning("post-sync heartbeat failed: %s", error)


if __name__ == "__main__":
    SyncAgent().run()
