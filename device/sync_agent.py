#!/usr/bin/env python3

from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import requests

from common import (
    CURRENT_DIR,
    DEFAULT_STATIC_IMAGE_PATH,
    PLAYER_STATE_PATH,
    PREVIOUS_DIR,
    STAGING_DIR,
    build_headers,
    copy_fallback_to_current,
    current_manifest_path,
    current_safety_file,
    ensure_directories,
    load_config,
    read_json,
    setup_logger,
    sha256_file,
    slot_static_path,
    statics_dir,
    utc_now_iso,
    write_player_command,
)


PLAYER_CONFIRMATION_TIMEOUT_SECONDS = 30


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
        self.cleanup_staging()

        if not self.is_valid_loop_directory(CURRENT_DIR) and self.is_valid_loop_directory(PREVIOUS_DIR):
            if CURRENT_DIR.exists():
                shutil.rmtree(CURRENT_DIR, ignore_errors=True)
            PREVIOUS_DIR.replace(CURRENT_DIR)
            self.logger.warning("restored previous content as current during boot recovery")

        if current_manifest_path().exists() and (CURRENT_DIR / "loop.mp4").exists():
            return

        if PREVIOUS_DIR.exists() and not self.is_valid_loop_directory(PREVIOUS_DIR):
            shutil.rmtree(PREVIOUS_DIR, ignore_errors=True)

        copy_fallback_to_current(self.config)
        write_player_command("reload", loopId="fallback")

    def sync_once(self) -> None:
        self.cleanup_staging()
        remote = self.fetch_manifest_info()
        local = self.load_local_manifest()

        if local and local.get("loopId") == remote["loopId"] and local.get("checksum") == remote["checksum"]:
            self.sync_player_flags(remote)
            self.logger.info("loop already current: %s", remote["loopId"])
            return

        staging_dir = self.download_loop(remote)
        self.activate(staging_dir, remote)
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
        staging_statics_dir = statics_dir(staging_dir)
        download_limit = int(self.config.raw["sync"]["maxBandwidthBytesPerSec"])
        timeout = int(self.config.raw["sync"]["downloadTimeoutSeconds"])

        try:
            staging_statics_dir.mkdir(parents=True, exist_ok=True)
            self.download_file(manifest_info["manifestUrl"], manifest_path, timeout, download_limit)

            with manifest_path.open("r", encoding="utf-8") as handle:
                manifest = json.load(handle)

            expected_manifest_checksum = manifest_info.get("checksum")
            if expected_manifest_checksum and manifest.get("checksum") != expected_manifest_checksum:
                raise RuntimeError("manifest checksum mismatch")

            compiled_video_url = manifest.get("compiledVideoUrl") or manifest_info.get("compiledVideoUrl")
            if not compiled_video_url:
                raise RuntimeError("manifest does not contain a compiledVideoUrl")

            self.download_file(compiled_video_url, video_path, timeout, download_limit)

            expected_checksum = manifest.get("compiledVideoChecksum")
            if expected_checksum and sha256_file(video_path) != expected_checksum:
                raise RuntimeError("compiled loop checksum mismatch")

            safety_payload = manifest.get("safetyVideo") or {}
            safety_url = safety_payload.get("url")
            safety_target = current_safety_file(staging_dir)
            if safety_url:
                self.download_file(str(safety_url), safety_target, timeout, download_limit)
                safety_checksum = safety_payload.get("checksum")
                if safety_checksum and sha256_file(safety_target) != safety_checksum:
                    raise RuntimeError("safety video checksum mismatch")
            else:
                safety_target.unlink(missing_ok=True)

            manifest_slots = {
                int(slot.get("position", 0)): slot for slot in manifest.get("slots", [])
            }
            for slot_index in range(10):
                slot_data = manifest_slots.get(slot_index, {})
                static_target = slot_static_path(slot_index, staging_dir)
                static_url = slot_data.get("staticImageUrl")
                static_checksum = slot_data.get("staticImageChecksum")

                if static_url:
                    self.download_file(str(static_url), static_target, timeout, download_limit)
                    if static_checksum and sha256_file(static_target) != static_checksum:
                        raise RuntimeError(f"static image checksum mismatch for slot {slot_index}")
                else:
                    self.copy_default_static(static_target)

            if not self.is_valid_loop_directory(staging_dir):
                raise RuntimeError("staging directory is incomplete after download")

            return staging_dir
        except Exception:  # noqa: BLE001
            shutil.rmtree(staging_dir, ignore_errors=True)
            raise

    def copy_default_static(self, target_path: Path) -> None:
        if not DEFAULT_STATIC_IMAGE_PATH.exists():
            raise RuntimeError(f"default static fallback image is missing: {DEFAULT_STATIC_IMAGE_PATH}")

        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(DEFAULT_STATIC_IMAGE_PATH, target_path)

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

    def activate(self, staging_dir: Path, manifest_info: dict) -> None:
        loop_id = str(manifest_info["loopId"])
        if not self.is_valid_loop_directory(staging_dir):
            raise RuntimeError(f"staging directory is not ready for activation: {staging_dir}")

        if PREVIOUS_DIR.exists():
            shutil.rmtree(PREVIOUS_DIR, ignore_errors=True)
        moved_current_to_previous = False

        try:
            if CURRENT_DIR.exists():
                CURRENT_DIR.replace(PREVIOUS_DIR)
                moved_current_to_previous = True
            staging_dir.replace(CURRENT_DIR)
        except Exception:  # noqa: BLE001
            if not CURRENT_DIR.exists() and moved_current_to_previous and PREVIOUS_DIR.exists():
                PREVIOUS_DIR.replace(CURRENT_DIR)
            raise

        command_id = f"reload-{loop_id}-{int(time.time() * 1000)}"
        write_player_command(
            "reload",
            loopId=loop_id,
            commandId=command_id,
            activatedAt=utc_now_iso(),
            disabled=bool(manifest_info.get("disabled")),
            disabledReason=manifest_info.get("disabledReason"),
        )

        if self.wait_for_player_confirmation(command_id, loop_id):
            if PREVIOUS_DIR.exists():
                shutil.rmtree(PREVIOUS_DIR, ignore_errors=True)
            self.cleanup_staging()
            return

        self.logger.error("player did not confirm activation for %s, rolling back", loop_id)
        self.rollback_activation(loop_id)
        raise RuntimeError(f"player failed to confirm loop activation: {loop_id}")

    def sync_player_flags(self, manifest_info: dict) -> None:
        write_player_command(
          "set_disabled",
          loopId=manifest_info.get("loopId"),
          disabled=bool(manifest_info.get("disabled")),
          disabledReason=manifest_info.get("disabledReason"),
        )

    def wait_for_player_confirmation(self, command_id: str, loop_id: str) -> bool:
        deadline = time.monotonic() + PLAYER_CONFIRMATION_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            state = read_json(PLAYER_STATE_PATH, {})
            if state.get("lastHandledCommandId") != command_id:
                time.sleep(1)
                continue

            if state.get("lastHandledOk") and state.get("lastHandledLoopId") == loop_id:
                return True

            self.logger.error("player rejected reload for %s: %s", loop_id, state)
            return False

        return False

    def rollback_activation(self, failed_loop_id: str) -> None:
        failed_current_dir = None
        if CURRENT_DIR.exists():
            failed_current_dir = STAGING_DIR / f"failed-{failed_loop_id}-{int(time.time() * 1000)}"
            if failed_current_dir.exists():
                shutil.rmtree(failed_current_dir, ignore_errors=True)
            CURRENT_DIR.replace(failed_current_dir)

        restored_loop_id = "fallback"
        if PREVIOUS_DIR.exists() and self.is_valid_loop_directory(PREVIOUS_DIR):
            PREVIOUS_DIR.replace(CURRENT_DIR)
            manifest = self.load_local_manifest() or {}
            restored_loop_id = str(manifest.get("loopId") or "fallback")
        else:
            if CURRENT_DIR.exists():
                shutil.rmtree(CURRENT_DIR, ignore_errors=True)
            copy_fallback_to_current(self.config)

        rollback_command_id = f"rollback-{restored_loop_id}-{int(time.time() * 1000)}"
        write_player_command(
            "reload",
            loopId=restored_loop_id,
            commandId=rollback_command_id,
            activatedAt=utc_now_iso(),
            rollbackFrom=failed_loop_id,
        )
        self.wait_for_player_confirmation(rollback_command_id, restored_loop_id)

        if failed_current_dir and failed_current_dir.exists():
            shutil.rmtree(failed_current_dir, ignore_errors=True)
        if PREVIOUS_DIR.exists():
            shutil.rmtree(PREVIOUS_DIR, ignore_errors=True)
        self.cleanup_staging()

    def cleanup_staging(self) -> None:
        if not STAGING_DIR.exists():
            return

        for path in STAGING_DIR.iterdir():
            self.remove_path(path)

    def remove_path(self, path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
            return
        path.unlink(missing_ok=True)

    def is_valid_loop_directory(self, directory: Path) -> bool:
        return directory.exists() and (directory / "manifest.json").exists() and (directory / "loop.mp4").exists()

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
