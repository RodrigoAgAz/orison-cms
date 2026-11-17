#!/usr/bin/env python3
"""Sync agent: keeps content/current in line with what the CMS says this cab should play.

Cabs lose power whenever the engine stops and pay for every megabyte, so:
- every file is flushed before it is renamed into place, and content is validated at boot
  (including the loop video's checksum) so a power cut cannot leave a cab stuck on a broken file;
- partial downloads are kept across cycles while the target is unchanged and resumed with Range;
- files already on disk (current, previous, a size-capped cache keyed by checksum) are reused
  instead of downloaded, and identical files are fetched once per cycle;
- a target (loop, checksum) that fails after download is retried with exponential backoff from
  about a minute to several hours, never in a tight loop;
- the safety message follows the manifest response when the server sends it, independently of
  the loop, so changing it in settings does not require a loop download.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

import requests

from sync_signal import SYNC_REQUEST_PATH, consume_sync_request, request_heartbeat
from common import (
    CACHE_DIR,
    CONTENT_DIR,
    CURRENT_DIR,
    PLAYER_STATE_PATH,
    PREVIOUS_DIR,
    SAFETY_META_NAME,
    STAGING_DIR,
    SYNC_INTERVAL_RANGE,
    SYNC_STATUS_PATH,
    VERIFIED_FILES_PATH,
    atomic_write_json,
    build_headers,
    checksum_hex,
    copy_fallback_to_current,
    current_manifest_path,
    current_safety_file,
    current_safety_image_file,
    durable_replace,
    effective_interval,
    ensure_directories,
    fsync_dir,
    fsync_tree,
    installed_safety,
    iso_from_epoch,
    load_config,
    normalize_safety,
    read_json,
    read_json_dict,
    safety_file_for,
    setup_logger,
    sha256_file,
    slot_static_path,
    statics_dir,
    utc_now_iso,
    write_player_command,
)


PLAYER_CONFIRMATION_TIMEOUT_SECONDS = 30
SYNC_REQUEST_POLL_SECONDS = 5
FAILURE_BACKOFF_INITIAL_SECONDS = 60
FAILURE_BACKOFF_MAX_SECONDS = 6 * 3600
TRANSIENT_BACKOFF_MAX_SECONDS = 15 * 60
MANIFEST_RETRY_INITIAL_SECONDS = 60
MANIFEST_RETRY_MAX_SECONDS = 15 * 60
NOTHING_ASSIGNED_INITIAL_SECONDS = 300
MAX_REMEMBERED_FAILURES = 10
MB = 1024 * 1024


class SyncError(RuntimeError):
    """A sync attempt failed after reaching the server (bad file, player, disk...)."""


class TransientError(SyncError):
    """Network trouble: nothing is wasted by retrying sooner (partial files are kept)."""


class NotFound(SyncError):
    pass


class InsufficientSpace(SyncError):
    pass


class NothingAssigned(Exception):
    """Manifest endpoint answered 404: no published loop for this cab. A normal state."""


class SyncAgent:
    def __init__(self) -> None:
        self.config = load_config()
        self.logger = setup_logger("orison-sync", "sync.log")
        self.session = requests.Session()
        self.status: dict[str, Any] = read_json_dict(SYNC_STATUS_PATH)
        self.status.setdefault("failures", {})
        self.verified: dict[str, str] = read_json_dict(VERIFIED_FILES_PATH)
        self.manifest_failures = 0
        self.nothing_assigned_count = 0
        self.warning: str | None = None

    # ------------------------------------------------------------------ main loop
    def run(self) -> None:
        ensure_directories()
        try:
            self.ensure_boot_content()
        except Exception as error:  # noqa: BLE001 - never crash-loop on local content problems
            self.logger.exception("boot content check failed: %s", error)

        self.logger.info("sync agent started")
        consume_sync_request()  # a request left over from before restart is moot: we sync right now
        while True:
            try:
                delay = self.sync_once()
            except Exception as error:  # noqa: BLE001
                self.logger.exception("sync cycle failed: %s", error)
                delay = 60
            self.wait_for_next_sync(max(float(delay), 5.0))

    def wait_for_next_sync(self, seconds: float, sleep=time.sleep, monotonic=time.monotonic) -> bool:
        """Sleep up to `seconds` in short steps; return True early if health_monitor requested a sync."""
        deadline = monotonic() + seconds
        while True:
            request = consume_sync_request(SYNC_REQUEST_PATH)
            if request is not None:
                self.logger.info("on-demand sync requested: %s", request.get("reasons"))
                return True
            remaining = deadline - monotonic()
            if remaining <= 0:
                return False
            sleep(min(SYNC_REQUEST_POLL_SECONDS, remaining))

    def sync_interval(self) -> int:
        return effective_interval(self.config.sync_interval_seconds, "syncIntervalSeconds", SYNC_INTERVAL_RANGE)

    def sync_once(self) -> float:
        """One sync cycle. Returns the number of seconds until the next one."""
        interval = self.sync_interval()
        self.warning = None
        try:
            info = self.fetch_manifest_info()
        except NothingAssigned:
            self.nothing_assigned_count += 1
            delay = min(NOTHING_ASSIGNED_INITIAL_SECONDS * 2 ** (self.nothing_assigned_count - 1), interval)
            self.logger.info("no loop is assigned to this cab; checking again in %ss", delay)
            self.set_state("ok", error="no published loop assigned to this cab", next_retry=delay)
            return delay
        except (requests.RequestException, ValueError) as error:
            self.manifest_failures += 1
            delay = min(MANIFEST_RETRY_INITIAL_SECONDS * 2 ** (self.manifest_failures - 1), MANIFEST_RETRY_MAX_SECONDS, interval)
            self.logger.warning("manifest request failed: %s; retrying in %ss", error, delay)
            self.set_state("failed", error=f"manifest request failed: {error}", next_retry=delay)
            return delay
        self.manifest_failures = 0
        self.nothing_assigned_count = 0

        if not isinstance(info, dict) or not info.get("loopId"):
            self.set_state("failed", error="manifest response has no loopId", next_retry=interval)
            return interval
        loop_id = str(info["loopId"])
        checksum = str(info.get("checksum") or "")

        if self.current_matches(loop_id, checksum):
            self.sync_player_flags(info)
            safety_delay = self.sync_safety(info)
            self.cleanup_staging(keep=None)
            if safety_delay is None:
                self.set_state("ok", error=self.warning)
                self.logger.info("loop already current: %s", loop_id)
                return interval
            return min(safety_delay, interval)

        key = self.target_key(loop_id, checksum)
        remaining = self.backoff_remaining(key)
        if remaining > 0:
            failure = self.status["failures"].get(key, {})
            self.logger.info("loop %s failed before (%s); next attempt in %.0fs", loop_id, failure.get("error"), remaining)
            self.sync_player_flags(info)
            self.set_state("failed", error=failure.get("error"), failed_loop=loop_id, next_retry=remaining)
            return min(remaining, interval)

        self.set_state("downloading", failed_loop=None)
        try:
            staging_dir = self.download_loop(info)
            self.activate(staging_dir, info)
        except Exception as error:  # noqa: BLE001
            delay = self.record_failure(key, loop_id, error)
            self.sync_player_flags(info)
            self.set_state("failed", error=str(error), failed_loop=loop_id, next_retry=delay)
            return min(delay, interval)

        self.clear_failure(key)
        self.set_state("ok", error=self.warning, last_synced=True)
        request_heartbeat("activated")
        self.evict_cache()
        self.logger.info("activated loop %s", loop_id)
        return interval

    # ------------------------------------------------------------------ status / backoff
    def set_state(self, state: str, *, error: str | None = None, failed_loop: str | None = None,
                  next_retry: float | None = None, last_synced: bool = False) -> None:
        now_iso = utc_now_iso()
        status = self.status
        if status.get("state") != state:
            status["since"] = now_iso
        status["state"] = state
        status["error"] = (str(error)[:300] if error else None)
        status["failedLoopId"] = failed_loop if state == "failed" else None
        status["nextRetryAt"] = iso_from_epoch(time.time() + next_retry) if next_retry else None
        if last_synced:
            status["lastSyncedAt"] = now_iso
        status.setdefault("lastSyncedAt", None)
        self._save_status()

    def _save_status(self) -> None:
        try:
            atomic_write_json(SYNC_STATUS_PATH, self.status)
        except OSError as error:
            self.logger.warning("could not write sync status: %s", error)

    @staticmethod
    def target_key(loop_id: str, checksum: str) -> str:
        return f"{loop_id}|{checksum}"

    def backoff_remaining(self, key: str) -> float:
        failure = self.status.get("failures", {}).get(key)
        if not isinstance(failure, dict):
            return 0.0
        remaining = float(failure.get("untilEpoch", 0)) - time.time()
        # A clock that jumped backwards must not park a target for longer than the maximum.
        return min(max(remaining, 0.0), FAILURE_BACKOFF_MAX_SECONDS)

    def record_failure(self, key: str, loop_id: str, error: Exception) -> float:
        failures = self.status.setdefault("failures", {})
        entry = failures.get(key) if isinstance(failures.get(key), dict) else {}
        count = int(entry.get("count", 0)) + 1
        cap = TRANSIENT_BACKOFF_MAX_SECONDS if isinstance(error, TransientError) else FAILURE_BACKOFF_MAX_SECONDS
        delay = float(min(FAILURE_BACKOFF_INITIAL_SECONDS * 2 ** (count - 1), cap))
        failures[key] = {
            "count": count,
            "untilEpoch": time.time() + delay,
            "error": str(error)[:300],
            "loopId": loop_id,
            "at": utc_now_iso(),
        }
        while len(failures) > MAX_REMEMBERED_FAILURES:
            oldest = min(failures, key=lambda k: failures[k].get("untilEpoch", 0))
            failures.pop(oldest)
        self._save_status()
        self.logger.warning("sync of %s failed (attempt %s): %s; next attempt in %.0fs", loop_id, count, error, delay)
        return delay

    def clear_failure(self, key: str) -> None:
        if self.status.get("failures", {}).pop(key, None) is not None:
            self._save_status()

    # ------------------------------------------------------------------ server
    def fetch_manifest_info(self) -> dict:
        response = self.session.get(
            f"{self.config.api_base_url}/devices/manifest",
            headers=build_headers(self.config),
            timeout=30,
        )
        if response.status_code == 404:
            raise NothingAssigned()
        response.raise_for_status()
        return response.json()

    def sync_player_flags(self, manifest_info: dict) -> None:
        write_player_command(
            "set_disabled",
            loopId=manifest_info.get("loopId"),
            disabled=bool(manifest_info.get("disabled")),
            disabledReason=manifest_info.get("disabledReason"),
        )

    # ------------------------------------------------------------------ content checks
    def load_local_manifest(self) -> dict | None:
        manifest = read_json(current_manifest_path(), None)
        return manifest if isinstance(manifest, dict) else None  # unreadable = no manifest

    def current_matches(self, loop_id: str, checksum: str) -> bool:
        local = self.load_local_manifest()
        if not local or local.get("loopId") != loop_id or str(local.get("checksum") or "") != checksum:
            return False
        ok, reason = self.validate_loop_dir(CURRENT_DIR, deep=True)
        if not ok:
            self.logger.warning("current content for %s is not usable (%s); downloading again", loop_id, reason)
        return ok

    def validate_loop_dir(self, directory: Path, *, deep: bool) -> tuple[bool, str]:
        manifest = read_json(directory / "manifest.json", None)
        if not isinstance(manifest, dict) or not manifest.get("loopId"):
            return False, "manifest missing or unreadable"
        video = directory / "loop.mp4"
        try:
            if video.stat().st_size <= 0:
                return False, "loop video is empty"
        except OSError:
            return False, "loop video missing"
        if deep and checksum_hex(manifest.get("compiledVideoChecksum")):
            if not self.verify_file(video, manifest["compiledVideoChecksum"]):
                return False, "loop video checksum mismatch"
        return True, "ok"

    def is_valid_loop_directory(self, directory: Path) -> bool:
        return self.validate_loop_dir(directory, deep=False)[0]

    def verify_file(self, path: Path, checksum: Any) -> bool:
        """True if the file is non-empty and matches the checksum (cached by inode/size/mtime)."""
        hexsum = checksum_hex(checksum)
        try:
            st = path.stat()
        except OSError:
            return False
        if st.st_size <= 0:
            return False
        if hexsum is None:
            return True
        key = f"{st.st_dev}:{st.st_ino}:{st.st_size}:{st.st_mtime_ns}"
        if self.verified.get(key) == hexsum:
            return True
        try:
            actual = checksum_hex(sha256_file(path))
        except OSError:
            return False
        if actual != hexsum:
            return False
        self.verified[key] = hexsum
        if len(self.verified) > 300:
            for old in list(self.verified)[:-200]:
                self.verified.pop(old, None)
        try:
            atomic_write_json(VERIFIED_FILES_PATH, self.verified, durable=False)
        except OSError:
            pass
        return True

    def ensure_boot_content(self) -> None:
        """Make sure content/current is something the player can use after a power cut."""
        ensure_directories()
        self.cleanup_staging_leftovers()
        ok, reason = self.validate_loop_dir(CURRENT_DIR, deep=True)
        if not ok:
            self.logger.warning("current content unusable at boot: %s", reason)
            if self.validate_loop_dir(PREVIOUS_DIR, deep=True)[0]:
                self._discard_current()
                PREVIOUS_DIR.replace(CURRENT_DIR)
                fsync_dir(CONTENT_DIR)
                self.logger.warning("restored previous content as current during boot recovery")
            else:
                self._discard_current()
                if copy_fallback_to_current(self.config):
                    self.logger.warning("installed the fallback video as current content")
                else:
                    self.logger.error(
                        "no usable content and no fallback video at %s; the screen shows the default still until a sync",
                        self.config.fallback_content_path,
                    )
            command_loop = (self.load_local_manifest() or {}).get("loopId")
            write_player_command("reload", loopId=command_loop, commandId=f"boot-{int(time.time() * 1000)}")
        self.repair_content(CURRENT_DIR)
        self.seed_cache(CURRENT_DIR)

    def _discard_current(self) -> None:
        if CURRENT_DIR.exists():
            trash = STAGING_DIR / f"discard-{int(time.time() * 1000)}"
            CURRENT_DIR.replace(trash)
            shutil.rmtree(trash, ignore_errors=True)
        CURRENT_DIR.mkdir(parents=True, exist_ok=True)

    def repair_content(self, directory: Path) -> None:
        """Remove still images and safety files a power cut left empty or corrupt (the player
        falls back to the default still; the next sync fetches them again)."""
        manifest = read_json_dict(directory / "manifest.json")
        declared = {}
        for slot in manifest.get("slots") or []:
            if isinstance(slot, dict) and isinstance(slot.get("position"), int):
                declared[slot_static_path(slot["position"], directory).name] = slot.get("staticImageChecksum")
        try:
            statics = list(statics_dir(directory).iterdir())
        except OSError:
            statics = []
        for path in statics:
            if not self.verify_file(path, declared.get(path.name)):
                self.logger.warning("removing damaged still %s", path)
                path.unlink(missing_ok=True)
        descriptor = installed_safety(directory)
        if descriptor and not self.verify_file(safety_file_for(descriptor, directory), descriptor.get("checksum")):
            self.logger.warning("removing damaged safety message")
            safety_file_for(descriptor, directory).unlink(missing_ok=True)
        for leftover in directory.glob("**/*.part"):
            leftover.unlink(missing_ok=True)

    # ------------------------------------------------------------------ download
    @staticmethod
    def staging_name(loop_id: str, checksum: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", loop_id)[:48]
        return f"{safe}-{hashlib.sha256(checksum.encode('utf-8')).hexdigest()[:12]}"

    def download_loop(self, manifest_info: dict) -> Path:
        loop_id = str(manifest_info["loopId"])
        checksum = str(manifest_info.get("checksum") or "")
        staging_dir = STAGING_DIR / self.staging_name(loop_id, checksum)
        self.cleanup_staging(keep=staging_dir.name)  # partial files for this target survive
        staging_dir.mkdir(parents=True, exist_ok=True)

        manifest = self.fetch_loop_manifest(manifest_info, staging_dir)
        fetched: dict[str, Path] = {}

        compiled_video_url = manifest.get("compiledVideoUrl") or manifest_info.get("compiledVideoUrl")
        if not compiled_video_url:
            raise SyncError("manifest does not contain a compiledVideoUrl")
        self.obtain(str(compiled_video_url), manifest.get("compiledVideoChecksum"), staging_dir / "loop.mp4", fetched, "loop video")

        wanted = set()
        for slot in manifest.get("slots") or []:
            if not isinstance(slot, dict):
                continue
            try:
                position = int(slot.get("position", 0))
            except (TypeError, ValueError):
                continue
            url = slot.get("staticImageUrl")
            if not url:
                continue  # no still for this slot: the player shows the default still
            target = slot_static_path(position, staging_dir)
            wanted.add(target.name)
            self.obtain(str(url), slot.get("staticImageChecksum"), target, fetched, f"still for slot {position}")
        try:
            for path in statics_dir(staging_dir).iterdir():
                if path.name not in wanted:
                    path.unlink(missing_ok=True)
        except OSError:
            pass

        if "safetyVideo" in manifest_info:
            self.install_safety(staging_dir, normalize_safety(manifest_info.get("safetyVideo")), fetched, authoritative=True)
        else:
            self.install_safety(staging_dir, normalize_safety(manifest.get("safetyVideo")), fetched, authoritative=False)

        ok, reason = self.validate_loop_dir(staging_dir, deep=False)
        if not ok:
            raise SyncError(f"staging directory is incomplete after download: {reason}")
        return staging_dir

    def fetch_loop_manifest(self, manifest_info: dict, staging_dir: Path) -> dict:
        path = staging_dir / "manifest.json"
        expected = manifest_info.get("checksum")
        existing = read_json(path, None)
        if isinstance(existing, dict) and expected and existing.get("checksum") == expected:
            return existing
        path.unlink(missing_ok=True)
        self.download_file(str(manifest_info["manifestUrl"]), path)
        manifest = read_json(path, None)
        if not isinstance(manifest, dict):
            path.unlink(missing_ok=True)
            raise SyncError("downloaded manifest is not valid JSON")
        if expected and manifest.get("checksum") != expected:
            path.unlink(missing_ok=True)
            raise SyncError("manifest checksum mismatch")
        return manifest

    def obtain(self, url: str, checksum: Any, target: Path, fetched: dict[str, Path], label: str) -> None:
        """Put the file at target: keep it if already staged, reuse an identical file from disk,
        or download it. Verifies the checksum when the manifest gives one."""
        hexsum = checksum_hex(checksum)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if self.verify_file(target, checksum):
                if hexsum:
                    fetched[hexsum] = target
                return
            target.unlink(missing_ok=True)
        key = hexsum or url
        if key in fetched and fetched[key].exists():
            self.link_or_copy(fetched[key], target)
            return
        if hexsum and self.reuse_from_disk(hexsum, checksum, target):
            fetched[hexsum] = target
            return
        self.download_file(url, target)
        try:
            empty = target.stat().st_size <= 0
        except OSError:
            empty = True
        if empty:
            target.unlink(missing_ok=True)
            raise SyncError(f"{label} downloaded empty")
        if hexsum and not self.verify_file(target, checksum):
            target.unlink(missing_ok=True)
            raise SyncError(f"{label} checksum mismatch")
        if hexsum:
            self.cache_add(hexsum, target)
        fetched[key] = target

    def download_file(self, url: str, target_path: Path, timeout_seconds: int | None = None,
                      max_bandwidth_bytes_per_sec: int | None = None) -> None:
        timeout = timeout_seconds or self.config.download_timeout_seconds
        limit = self.config.max_bandwidth_bytes_per_sec if max_bandwidth_bytes_per_sec is None else max_bandwidth_bytes_per_sec
        retries = self.config.max_download_retries
        part_path = target_path.with_name(target_path.name + ".part")
        last_error: Exception | None = None

        for attempt in range(1, retries + 1):
            try:
                have = part_path.stat().st_size if part_path.exists() else 0
                headers = {"Range": f"bytes={have}-"} if have > 0 else {}
                response = self.session.get(url, headers=headers, stream=True, timeout=timeout)
                with response:
                    if have > 0 and response.status_code == 416:
                        durable_replace(part_path, target_path)  # already complete
                        return
                    if response.status_code in (404, 410):
                        raise NotFound(f"{target_path.name}: HTTP {response.status_code}")
                    response.raise_for_status()
                    mode = "wb"
                    if have > 0 and response.status_code == 206:
                        match = re.match(r"bytes (\d+)-", response.headers.get("Content-Range", ""))
                        if match and int(match.group(1)) == have:
                            mode = "ab"
                    if mode == "wb":
                        have = 0
                    remaining = int(response.headers.get("Content-Length") or 0)
                    self.ensure_space(remaining)

                    received = 0
                    started = time.monotonic()
                    with part_path.open(mode) as handle:
                        for chunk in response.iter_content(chunk_size=256 * 1024):
                            if not chunk:
                                continue
                            handle.write(chunk)
                            received += len(chunk)  # bytes of THIS request only (resume-safe throttle)
                            if limit > 0:
                                elapsed = max(time.monotonic() - started, 0.001)
                                allowed = elapsed * limit
                                if received > allowed:
                                    time.sleep((received - allowed) / limit)
                        handle.flush()
                        os.fsync(handle.fileno())
                    if remaining and received < remaining:
                        raise TransientError(f"{target_path.name}: connection closed after {received} of {remaining} bytes")
                durable_replace(part_path, target_path)
                return
            except (NotFound, InsufficientSpace):
                raise
            except Exception as error:  # noqa: BLE001
                last_error = error
                self.logger.warning("download attempt %s failed for %s: %s", attempt, target_path.name, error)
                if attempt < retries:
                    time.sleep(2**attempt)

        raise TransientError(f"download of {target_path.name} failed: {last_error}")

    def ensure_space(self, nbytes: int) -> None:
        reserve = self.config.min_free_space_mb * MB
        if self._free_bytes() >= nbytes + reserve:
            return
        self.free_up_space()
        free = self._free_bytes()
        if free < nbytes + reserve:
            raise InsufficientSpace(
                f"not enough disk space: need {nbytes // MB} MB plus {reserve // MB} MB reserve, {free // MB} MB free"
            )

    def _free_bytes(self) -> int:
        try:
            return shutil.disk_usage(CONTENT_DIR).free
        except OSError:
            return 0

    def free_up_space(self) -> None:
        self.logger.warning("low on disk space: emptying the content cache and removing the previous loop")
        self.evict_cache(cap_bytes=0)
        if PREVIOUS_DIR.exists():
            shutil.rmtree(PREVIOUS_DIR, ignore_errors=True)

    def install_safety(self, directory: Path, target: dict | None, fetched: dict[str, Path], *, authoritative: bool) -> None:
        """Install the safety message into a content directory and record it in safety.json."""
        video, image = current_safety_file(directory), current_safety_image_file(directory)
        meta_path = directory / SAFETY_META_NAME
        if target is None:
            video.unlink(missing_ok=True)
            image.unlink(missing_ok=True)
            atomic_write_json(meta_path, {"safetyVideo": None})
            return
        dest = safety_file_for(target, directory)
        try:
            self.obtain(target["url"], target.get("checksum"), dest, fetched, "safety message")
        except (SyncError, OSError) as error:
            # The safety message must not hold the loop hostage. On an old server this is what
            # happens when the safety message was removed from settings after the loop was
            # published (the loop manifest still points at the deleted file). Keep the installed
            # one; with a new server, sync_safety retries it on its own schedule.
            kept = installed_safety(CURRENT_DIR)
            video.unlink(missing_ok=True)
            image.unlink(missing_ok=True)
            if kept:
                self.link_or_copy(safety_file_for(kept, CURRENT_DIR), safety_file_for(kept, directory))
            atomic_write_json(meta_path, {"safetyVideo": kept})
            self.warning = f"safety message unavailable ({error}); kept the installed one" if kept else \
                f"safety message unavailable ({error}); none installed"
            self.logger.warning(self.warning)
            return
        (image if dest == video else video).unlink(missing_ok=True)
        atomic_write_json(meta_path, {"safetyVideo": target})

    def sync_safety(self, manifest_info: dict) -> float | None:
        """Follow the safety message from the manifest response (new servers) for the current loop.
        Returns None when done or nothing to do, else seconds until it should be retried."""
        if "safetyVideo" not in manifest_info:
            return None  # old server: no opinion, the loop manifest's copy stays in force
        target = normalize_safety(manifest_info.get("safetyVideo"))
        installed = installed_safety(CURRENT_DIR)
        meta = read_json(CURRENT_DIR / SAFETY_META_NAME, None)
        want = checksum_hex(target.get("checksum")) if target else None
        have = checksum_hex(installed.get("checksum")) if installed else None
        if target is None and installed is None and isinstance(meta, dict) and meta.get("safetyVideo") is None:
            return None
        if target and installed and want and want == have and safety_file_for(target) == safety_file_for(installed):
            if not (isinstance(meta, dict) and meta.get("safetyVideo") == target):
                atomic_write_json(CURRENT_DIR / SAFETY_META_NAME, {"safetyVideo": target})
            return None

        key = f"safety|{want}"
        remaining = self.backoff_remaining(key)
        if remaining > 0:
            failure = self.status["failures"].get(key, {})
            self.set_state("failed", error=failure.get("error"), next_retry=remaining)
            return remaining
        work = STAGING_DIR / f"safety-{(want or 'none')[:12]}"
        try:
            work.mkdir(parents=True, exist_ok=True)
            if target is not None:
                staged = safety_file_for(target, work)
                self.obtain(target["url"], target.get("checksum"), staged, {}, "safety message")
                durable_replace(staged, safety_file_for(target, CURRENT_DIR))
                other = current_safety_image_file() if safety_file_for(target) == current_safety_file() else current_safety_file()
                other.unlink(missing_ok=True)
            else:
                current_safety_file().unlink(missing_ok=True)
                current_safety_image_file().unlink(missing_ok=True)
            atomic_write_json(CURRENT_DIR / SAFETY_META_NAME, {"safetyVideo": target})
        except Exception as error:  # noqa: BLE001
            delay = self.record_failure(key, "safety", SyncError(f"safety message update failed: {error}"))
            self.set_state("failed", error=f"safety message update failed: {error}", next_retry=delay)
            return delay
        finally:
            shutil.rmtree(work, ignore_errors=True)
        self.clear_failure(key)
        self.logger.info("safety message updated (%s)", want or "removed")
        request_heartbeat("safety")
        return None

    # ------------------------------------------------------------------ reuse cache
    def link_or_copy(self, source: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + ".link")
        temp.unlink(missing_ok=True)
        try:
            os.link(source, temp)
        except OSError:
            shutil.copyfile(source, temp)
        durable_replace(temp, target)

    def cache_add(self, hexsum: str, path: Path) -> None:
        """Hard-link a verified file into the cache (costs no space while the loop uses it)."""
        entry = CACHE_DIR / hexsum
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        if not entry.exists():
            try:
                os.link(path, entry)
            except OSError:
                return  # filesystem without hard links: no cache, previous/current still reused
        self._touch_cache(hexsum)

    def _cache_index(self) -> dict[str, float]:
        return read_json_dict(CACHE_DIR / "index.json")

    def _touch_cache(self, hexsum: str) -> None:
        index = self._cache_index()
        index[hexsum] = time.time()
        try:
            atomic_write_json(CACHE_DIR / "index.json", index, durable=False)
        except OSError:
            pass

    def reuse_from_disk(self, hexsum: str, checksum: Any, target: Path) -> bool:
        candidate = CACHE_DIR / hexsum
        if candidate.exists():
            if self.verify_file(candidate, checksum):
                self.link_or_copy(candidate, target)
                self._touch_cache(hexsum)
                self.logger.info("reused %s from cache", target.name)
                return True
            candidate.unlink(missing_ok=True)
        for directory in (CURRENT_DIR, PREVIOUS_DIR):
            for path, declared in self.declared_files(directory):
                if checksum_hex(declared) == hexsum and self.verify_file(path, checksum):
                    self.link_or_copy(path, target)
                    self.cache_add(hexsum, path)
                    self.logger.info("reused %s from %s", target.name, directory.name)
                    return True
        return False

    def declared_files(self, directory: Path) -> list[tuple[Path, Any]]:
        manifest = read_json_dict(directory / "manifest.json")
        files: list[tuple[Path, Any]] = [(directory / "loop.mp4", manifest.get("compiledVideoChecksum"))]
        for slot in manifest.get("slots") or []:
            if isinstance(slot, dict) and isinstance(slot.get("position"), int):
                files.append((slot_static_path(slot["position"], directory), slot.get("staticImageChecksum")))
        safety = installed_safety(directory)
        if safety:
            files.append((safety_file_for(safety, directory), safety.get("checksum")))
        return files

    def seed_cache(self, directory: Path) -> None:
        """Content installed by older firmware is not in the cache yet: link verified files in."""
        for path, declared in self.declared_files(directory):
            hexsum = checksum_hex(declared)
            if hexsum and not (CACHE_DIR / hexsum).exists() and self.verify_file(path, declared):
                self.cache_add(hexsum, path)

    def evict_cache(self, cap_bytes: int | None = None) -> None:
        """Keep cache entries not used by current/previous/staging under the size cap (LRU)."""
        cap = self.config.cache_max_mb * MB if cap_bytes is None else cap_bytes
        index = self._cache_index()
        unshared: list[tuple[float, Path, int]] = []
        try:
            entries = list(CACHE_DIR.iterdir())
        except OSError:
            return
        for path in entries:
            if path.name == "index.json" or path.name.startswith("."):
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            if st.st_nlink <= 1:
                unshared.append((float(index.get(path.name, 0)), path, st.st_size))
        total = sum(size for _, _, size in unshared)
        for _, path, size in sorted(unshared, key=lambda item: item[0]):
            if total <= cap:
                break
            path.unlink(missing_ok=True)
            index.pop(path.name, None)
            total -= size
        index = {k: v for k, v in index.items() if (CACHE_DIR / k).exists()}
        try:
            atomic_write_json(CACHE_DIR / "index.json", index, durable=False)
        except OSError:
            pass

    # ------------------------------------------------------------------ activation
    def activate(self, staging_dir: Path, manifest_info: dict) -> None:
        loop_id = str(manifest_info["loopId"])
        ok, reason = self.validate_loop_dir(staging_dir, deep=False)
        if not ok:
            raise SyncError(f"staging directory is not ready for activation: {reason}")

        fsync_tree(staging_dir)  # data on disk before the rename makes it live
        if PREVIOUS_DIR.exists():
            shutil.rmtree(PREVIOUS_DIR, ignore_errors=True)
        moved_current_to_previous = False
        try:
            if CURRENT_DIR.exists():
                CURRENT_DIR.replace(PREVIOUS_DIR)
                moved_current_to_previous = True
            staging_dir.replace(CURRENT_DIR)
            fsync_dir(CONTENT_DIR)
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
            self.cleanup_staging(keep=None)
            return  # previous stays on disk: switching back costs no download

        self.logger.error("player did not confirm activation for %s, rolling back", loop_id)
        self.rollback_activation(loop_id, staging_dir)
        raise SyncError(f"player failed to confirm loop activation: {loop_id}")

    def wait_for_player_confirmation(self, command_id: str, loop_id: str) -> bool:
        deadline = time.monotonic() + PLAYER_CONFIRMATION_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            state = read_json_dict(PLAYER_STATE_PATH)
            if state.get("lastHandledCommandId") != command_id:
                time.sleep(1)
                continue

            if state.get("lastHandledOk") and state.get("lastHandledLoopId") == loop_id:
                return True

            self.logger.error("player rejected reload for %s: %s", loop_id, state)
            return False

        return False

    def rollback_activation(self, failed_loop_id: str, staging_dir: Path | None = None) -> None:
        if CURRENT_DIR.exists():
            # Keep the verified files where the next attempt (after backoff) will find them.
            keep_at = staging_dir or (STAGING_DIR / f"failed-{int(time.time() * 1000)}")
            if keep_at.exists():
                shutil.rmtree(keep_at, ignore_errors=True)
            CURRENT_DIR.replace(keep_at)

        restored_loop_id = "fallback"
        if PREVIOUS_DIR.exists() and self.is_valid_loop_directory(PREVIOUS_DIR):
            PREVIOUS_DIR.replace(CURRENT_DIR)
            restored_loop_id = str((self.load_local_manifest() or {}).get("loopId") or "fallback")
        else:
            CURRENT_DIR.mkdir(parents=True, exist_ok=True)
            copy_fallback_to_current(self.config)
        fsync_dir(CONTENT_DIR)

        rollback_command_id = f"rollback-{restored_loop_id}-{int(time.time() * 1000)}"
        write_player_command(
            "reload",
            loopId=restored_loop_id,
            commandId=rollback_command_id,
            activatedAt=utc_now_iso(),
            rollbackFrom=failed_loop_id,
        )
        self.wait_for_player_confirmation(rollback_command_id, restored_loop_id)

    # ------------------------------------------------------------------ housekeeping
    def cleanup_staging(self, keep: str | None) -> None:
        """Remove staged content except the directory for the current target (partial downloads)."""
        if not STAGING_DIR.exists():
            return
        for path in STAGING_DIR.iterdir():
            if keep is not None and path.name == keep:
                continue
            self.remove_path(path)

    def cleanup_staging_leftovers(self) -> None:
        """At boot the target is not known yet: keep loop staging dirs, drop the rest."""
        if not STAGING_DIR.exists():
            return
        for path in STAGING_DIR.iterdir():
            if path.name.startswith(("failed-", "discard-", "invalid-", "safety-", ".")) or path.suffix == ".tmp":
                self.remove_path(path)

    def remove_path(self, path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
            return
        path.unlink(missing_ok=True)


if __name__ == "__main__":
    SyncAgent().run()
