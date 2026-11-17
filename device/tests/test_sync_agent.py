"""Regression tests for the sync agent: resume, backoff, durability, reuse and the safety message.

Runs the real SyncAgent against a local HTTP server that supports Range requests, can drop
connections part-way and counts the bytes it serves. Finding numbers refer to the device audit.
"""

import hashlib
import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402
from support import BASE, reset_base_dir  # noqa: E402

import common  # noqa: E402
import sync_agent  # noqa: E402


def sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


class FakeServer:
    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.requests: list[tuple[str, str | None]] = []
        self.served = 0
        self.drop_after: int | None = None
        self.drops_left = 0
        self.status_override: dict[str, int] = {}
        self.manifest_response: dict | None = None
        self.manifest_status = 200
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                rng = self.headers.get("Range")
                server.requests.append((self.path, rng))
                if self.path == "/api/devices/manifest":
                    if server.manifest_status != 200:
                        self.send_response(server.manifest_status)
                        self.end_headers()
                        return
                    body = json.dumps(server.manifest_response).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if self.path in server.status_override:
                    self.send_response(server.status_override[self.path])
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = server.files.get(self.path)
                if body is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                start = 0
                if rng:
                    start = int(rng.split("=")[1].split("-")[0])
                    if start >= len(body):
                        self.send_response(416)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body) - start))
                self.end_headers()
                chunk = body[start:]
                if server.drops_left > 0 and server.drop_after and self.path.endswith(".mp4"):
                    server.drops_left -= 1
                    part = chunk[: server.drop_after]
                    self.wfile.write(part)
                    server.served += len(part)
                    self.wfile.flush()
                    self.connection.shutdown(2)
                    return
                self.wfile.write(chunk)
                if self.path.endswith(".mp4"):
                    server.served += len(chunk)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"

    def reset_counters(self):
        self.requests.clear()
        self.served = 0

    def paths_requested(self):
        return [path for path, _ in self.requests]

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class FakePlayer:
    """Confirms reload commands the way player_manager.handle_commands reports them."""

    def __init__(self):
        self.stop = threading.Event()
        self.reject = False
        self.commands = []
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while not self.stop.is_set():
            cmd = common.read_json(common.PLAYER_COMMAND_PATH)
            if isinstance(cmd, dict):
                common.PLAYER_COMMAND_PATH.unlink(missing_ok=True)
                self.commands.append(cmd)
                ok = not (self.reject and str(cmd.get("commandId", "")).startswith("reload-"))
                common.atomic_write_json(common.PLAYER_STATE_PATH, {
                    "lastHandledCommandId": str(cmd.get("commandId") or cmd.get("ts")),
                    "lastHandledLoopId": cmd.get("loopId"),
                    "lastHandledOk": ok,
                    "disabled": bool(cmd.get("disabled")),
                }, durable=False)
            time.sleep(0.02)


class WallClock:
    """Controllable wall clock; sleeping advances the clocks instead of waiting."""

    def __init__(self):
        self.offset = 0.0
        self.mono_offset = 0.0
        self.slept: list[float] = []

    def time(self):
        return time.time() + self.offset

    def monotonic(self):
        return time.monotonic() + self.mono_offset

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.mono_offset += seconds
        time.sleep(min(seconds, 0.02))


class SyncTestBase(unittest.TestCase):
    loop_bytes = 3 * 1024 * 1024

    def setUp(self):
        config = json.loads(json.dumps(support.CONFIG))
        self.server = FakeServer()
        config["device"]["apiBaseUrl"] = self.server.url + "/api"
        reset_base_dir(config)
        (BASE / "fallback.mp4").write_bytes(b"fallback-video")
        self.clock = WallClock()
        self.patch = mock.patch.object(sync_agent, "time", self.clock)
        self.patch.start()
        self.player = FakePlayer()
        self.loop = os.urandom(self.loop_bytes)
        self.static = b"\xff\xd8placeholder-still"
        self.safety = b"safety-video-bytes"
        self.server.files.update({"/loop-1.mp4": self.loop, "/static.jpg": self.static, "/safety-1.mp4": self.safety})
        self.publish("L1", "/loop-1.mp4")
        self.agent = sync_agent.SyncAgent()
        self.agent.logger.setLevel(100)

    def tearDown(self):
        self.player.stop.set()
        self.patch.stop()
        self.server.stop()

    def publish(self, loop_id, video_path, *, video_checksum=None, slots=True, safety_in_manifest=True,
                response_safety="absent", disabled=False):
        body = self.server.files[video_path]
        manifest = {
            "loopId": loop_id,
            "totalDurationMs": 600000,
            "compiledVideoUrl": self.server.url + video_path,
            "compiledVideoChecksum": video_checksum or sha(body),
            "slots": [
                {"position": i, "staticImageAssetId": None, "staticImageUrl": self.server.url + "/static.jpg",
                 "staticImageChecksum": sha(self.static), "contents": []}
                for i in range(10)
            ] if slots else [],
            "totalDownloadSizeBytes": len(body),
        }
        if safety_in_manifest:
            manifest["safetyVideo"] = {"url": self.server.url + "/safety-1.mp4", "checksum": sha(self.safety),
                                       "durationMs": 8000, "mimeType": "video/mp4"}
        manifest["checksum"] = "m-" + loop_id + "-" + manifest["compiledVideoChecksum"][-8:]
        self.server.files[f"/manifest-{loop_id}.json"] = json.dumps(manifest).encode()
        response = {
            "loopId": loop_id, "checksum": manifest["checksum"], "manifestUrl": self.server.url + f"/manifest-{loop_id}.json",
            "version": 1, "compiledVideoUrl": None, "disabled": disabled, "disabledReason": None,
        }
        if response_safety != "absent":
            response["safetyVideo"] = response_safety
        self.server.manifest_response = response
        return manifest

    def sync(self):
        self.server.reset_counters()
        return self.agent.sync_once()

    def loop_bytes_served(self):
        return self.server.served

    def status(self):
        return common.read_json(common.SYNC_STATUS_PATH)

    def local_loop(self):
        return (common.read_json(common.current_manifest_path(), {}) or {}).get("loopId")


class TestResumeAndBackoff(SyncTestBase):
    """Finding 9."""

    def test_checksum_mismatch_backs_off_instead_of_redownloading(self):
        self.publish("BAD", "/loop-1.mp4", video_checksum="sha256:" + "0" * 64)
        delay = self.sync()
        self.assertGreaterEqual(self.loop_bytes_served(), self.loop_bytes)
        self.assertGreaterEqual(delay, 55)
        st = self.status()
        self.assertEqual(st["state"], "failed")
        self.assertEqual(st["failedLoopId"], "BAD")
        self.assertIn("checksum mismatch", st["error"])
        self.assertIsNotNone(st["nextRetryAt"])
        for _ in range(5):  # sync requests from heartbeats inside the backoff window
            self.sync()
            self.assertNotIn("/loop-1.mp4", self.server.paths_requested())
        self.clock.offset += 61
        delay = self.sync()
        self.assertIn("/loop-1.mp4", self.server.paths_requested())
        self.assertGreaterEqual(delay, 115)  # doubled
        self.clock.offset += 10 * 3600
        for _ in range(12):
            self.clock.offset += sync_agent.FAILURE_BACKOFF_MAX_SECONDS + 1
            delay = self.sync()
        self.assertLessEqual(delay, max(sync_agent.FAILURE_BACKOFF_MAX_SECONDS, self.agent.sync_interval()))
        self.assertEqual(self.agent.status["failures"]["BAD|" + self.server.manifest_response["checksum"]]["count"], 14)

    def test_partial_download_survives_across_cycles(self):
        self.server.drop_after = 1_000_000
        self.server.drops_left = 2  # every attempt of the first cycle (maxDownloadRetries=2)
        self.sync()
        self.assertEqual(self.status()["state"], "failed")
        parts = list(common.STAGING_DIR.glob("*/loop.mp4.part"))
        self.assertEqual(len(parts), 1)
        kept = parts[0].stat().st_size
        self.assertGreater(kept, 1_000_000)  # both attempts' bytes, resumed within the cycle
        self.clock.offset += 61
        self.agent.ensure_boot_content()  # a reboot in between keeps it too
        self.assertTrue(parts[0].exists())
        self.sync()
        self.assertEqual(self.local_loop(), "L1")
        self.assertEqual(self.loop_bytes_served(), self.loop_bytes - kept + len(self.safety))
        ranges = [r for p, r in self.server.requests if p == "/loop-1.mp4"]
        self.assertEqual(ranges, [f"bytes={kept}-"])
        self.assertEqual(common.sha256_file(common.current_loop_file()), sha(self.loop))

    def test_player_not_confirming_rolls_back_and_keeps_files(self):
        self.sync()
        self.assertEqual(self.local_loop(), "L1")
        self.server.files["/loop-2.mp4"] = os.urandom(1024 * 1024)
        self.publish("L2", "/loop-2.mp4")
        self.player.reject = True
        self.sync()
        self.assertEqual(self.local_loop(), "L1")
        self.assertEqual(self.status()["state"], "failed")
        self.player.reject = False
        self.sync()  # inside backoff: nothing
        self.assertNotIn("/loop-2.mp4", self.server.paths_requested())
        self.clock.offset += 61
        self.sync()
        self.assertEqual(self.local_loop(), "L2")
        self.assertEqual(self.loop_bytes_served(), 0)  # nothing downloaded twice
        self.assertEqual(self.status()["state"], "ok")
        self.assertIsNotNone(self.status()["lastSyncedAt"])

    def test_free_space_checked_before_downloading(self):
        usage = mock.Mock(free=50 * 1024 * 1024)
        with mock.patch.object(sync_agent.shutil, "disk_usage", return_value=usage):
            self.sync()
        st = self.status()
        self.assertEqual(st["state"], "failed")
        self.assertIn("not enough disk space", st["error"])
        self.assertEqual(list(common.STAGING_DIR.glob("*/loop.mp4.part")), [])

    def test_nothing_assigned_is_not_retried_every_30s(self):
        """Finding 24: manifest 404."""
        self.server.manifest_status = 404
        delays = [self.sync() for _ in range(3)]
        self.assertEqual(delays, [300, 600, 1200])
        self.assertEqual(self.status()["state"], "ok")

    def test_manifest_network_failure_backs_off(self):
        self.server.manifest_status = 503
        delays = [self.sync() for _ in range(3)]
        self.assertEqual(delays, [60, 120, 240])
        self.assertIn("manifest request failed", self.status()["error"])

    def test_disabled_flag_still_applied_while_loop_in_backoff(self):
        self.publish("BAD", "/loop-1.mp4", video_checksum="sha256:" + "0" * 64, disabled=True)
        self.sync()
        self.sync()
        time.sleep(0.2)
        self.assertTrue(any(c["action"] == "set_disabled" and c["disabled"] for c in self.player.commands))

    def test_throttle_does_not_oversleep_after_resume(self):
        """Finding 24: the throttle counted resumed bytes as if downloaded in this request."""
        self.agent.config.raw["sync"]["maxBandwidthBytesPerSec"] = 2_000_000
        info = self.server.manifest_response
        staging = common.STAGING_DIR / self.agent.staging_name(info["loopId"], info["checksum"])
        staging.mkdir(parents=True)
        (staging / "loop.mp4.part").write_bytes(self.loop[:2_500_000])  # left by an earlier cycle
        download_sleeps = []
        real_activate = self.agent.activate
        self.agent.activate = lambda *a: (download_sleeps.extend(self.clock.slept), real_activate(*a))
        self.sync()
        self.assertEqual(self.local_loop(), "L1")
        self.assertEqual(self.loop_bytes_served(), self.loop_bytes - 2_500_000 + len(self.safety))
        # ~0.65 MB fetched at 2 MB/s is ~0.3 s; counting the resumed 2.5 MB would add ~1.25 s.
        self.assertLess(sum(download_sleeps), 0.6)


class TestDurability(SyncTestBase):
    """Finding 10."""

    def test_zero_length_manifest_after_power_cut(self):
        self.sync()
        common.current_manifest_path().write_text("")
        self.agent.ensure_boot_content()
        self.assertEqual(self.local_loop(), "fallback")
        self.sync()
        self.assertEqual(self.local_loop(), "L1")
        self.assertEqual(self.loop_bytes_served(), 0)  # verified copy reused from the cache

    def test_zero_length_video_is_not_accepted(self):
        self.sync()
        common.current_loop_file().write_bytes(b"")  # same inode as the cache entry: both lost
        self.agent = sync_agent.SyncAgent()
        self.agent.ensure_boot_content()
        self.assertEqual(self.local_loop(), "fallback")
        self.sync()
        self.assertEqual(self.local_loop(), "L1")
        self.assertEqual(common.sha256_file(common.current_loop_file()), sha(self.loop))

    def test_corrupt_video_detected_by_checksum_at_boot(self):
        self.sync()
        os.unlink(common.CACHE_DIR / hashlib.sha256(self.loop).hexdigest())
        data = bytearray(self.loop)
        data[100] ^= 0xFF
        tmp = common.CURRENT_DIR / "x"
        tmp.write_bytes(bytes(data))
        os.replace(tmp, common.current_loop_file())
        self.agent = sync_agent.SyncAgent()
        self.agent.ensure_boot_content()
        self.assertEqual(self.local_loop(), "fallback")

    def test_previous_restored_when_current_broken(self):
        self.sync()
        self.server.files["/loop-2.mp4"] = os.urandom(100_000)
        self.publish("L2", "/loop-2.mp4")
        self.sync()
        self.assertTrue((common.PREVIOUS_DIR / "loop.mp4").exists())
        common.current_manifest_path().write_text("{trunc")
        self.agent.ensure_boot_content()
        self.assertEqual(self.local_loop(), "L1")

    def test_missing_fallback_does_not_crash_boot(self):
        (BASE / "fallback.mp4").unlink()
        self.agent.ensure_boot_content()  # must not raise (it used to crash-loop the service)
        self.sync()
        self.assertEqual(self.local_loop(), "L1")

    def test_files_flushed_before_rename(self):
        calls = []
        real_fsync = os.fsync
        with mock.patch.object(sync_agent, "durable_replace", wraps=sync_agent.durable_replace) as replace, \
                mock.patch.object(sync_agent, "fsync_tree", wraps=lambda p: calls.append(("tree", p.name)) or common.fsync_tree(p)), \
                mock.patch.object(sync_agent.os, "fsync", side_effect=lambda fd: calls.append("fsync") or real_fsync(fd)):
            self.sync()
        targets = [c.args[1].name for c in replace.call_args_list]
        self.assertIn("loop.mp4", targets)
        self.assertIn("manifest.json", targets)
        self.assertIn("fsync", calls)
        self.assertTrue(any(isinstance(c, tuple) and c[0] == "tree" for c in calls))

    def test_unreadable_current_manifest_treated_as_none(self):
        common.CURRENT_DIR.mkdir(parents=True, exist_ok=True)
        common.current_manifest_path().write_bytes(b"\x00\x00")
        self.assertIsNone(self.agent.load_local_manifest())
        self.sync()
        self.assertEqual(self.local_loop(), "L1")

    def test_old_firmware_content_boots_and_is_reused(self):
        # What firmware 1.0/1.1 leaves: manifest with the safety copy inside, ten statics, no safety.json.
        manifest = self.publish("OLD", "/loop-1.mp4")
        cur = common.CURRENT_DIR
        (cur / "statics").mkdir(parents=True, exist_ok=True)
        (cur / "loop.mp4").write_bytes(self.loop)
        (cur / "safety.mp4").write_bytes(self.safety)
        for i in range(10):
            (cur / "statics" / f"slot_{i:02d}.jpg").write_bytes(self.static)
        (cur / "manifest.json").write_text(json.dumps(manifest))
        self.agent.ensure_boot_content()
        self.assertEqual(self.local_loop(), "OLD")
        self.assertEqual(common.installed_safety()["checksum"], sha(self.safety))
        self.sync()  # same target: nothing to do
        self.assertEqual(self.server.paths_requested(), ["/api/devices/manifest"])
        self.server.files["/loop-2.mp4"] = os.urandom(10_000)
        self.publish("L2", "/loop-2.mp4")
        self.sync()
        self.assertEqual(self.local_loop(), "L2")
        self.assertNotIn("/static.jpg", self.server.paths_requested())
        self.assertNotIn("/safety-1.mp4", self.server.paths_requested())


class TestReuse(SyncTestBase):
    """Finding 21."""

    def test_identical_stills_downloaded_once(self):
        self.sync()
        self.assertEqual(self.server.paths_requested().count("/static.jpg"), 1)
        for i in range(10):
            self.assertEqual(common.slot_static_path(i).read_bytes(), self.static)

    def test_fleet_override_fleet_downloads_the_fleet_loop_once(self):
        self.sync()
        self.server.files["/loop-2.mp4"] = os.urandom(512 * 1024)
        fleet = dict(self.server.manifest_response)
        self.publish("OVERRIDE", "/loop-2.mp4")
        self.sync()
        self.assertEqual(self.local_loop(), "OVERRIDE")
        self.server.manifest_response = fleet
        self.sync()
        self.assertEqual(self.local_loop(), "L1")
        self.assertNotIn("/loop-1.mp4", self.server.paths_requested())
        self.assertEqual(self.loop_bytes_served(), 0)

    def test_cache_is_capped(self):
        self.agent.config.raw["sync"]["cacheMaxMb"] = 1
        self.sync()
        for n in range(2, 6):
            self.server.files[f"/loop-{n}.mp4"] = os.urandom(700 * 1024)
            self.publish(f"L{n}", f"/loop-{n}.mp4")
            self.sync()
        unshared = [p for p in common.CACHE_DIR.iterdir() if p.name != "index.json" and p.stat().st_nlink == 1]
        self.assertLessEqual(sum(p.stat().st_size for p in unshared), 1024 * 1024)

    def test_slotless_loop_without_default_still_installed(self):
        """Finding 17: the sync agent no longer needs the default still for slots without one."""
        self.publish("DIRECT", "/loop-1.mp4", slots=False)
        with mock.patch.object(common, "DEFAULT_STATIC_IMAGE_PATH", BASE / "missing.jpg"):
            self.sync()
        self.assertEqual(self.local_loop(), "DIRECT")


class TestSafetyMessage(SyncTestBase):
    """Finding 11."""

    def test_old_server_uses_manifest_copy(self):
        self.sync()
        self.assertEqual(common.installed_safety()["checksum"], sha(self.safety))

    def test_response_safety_change_downloads_only_the_safety_file(self):
        self.sync()
        new = b"new-safety-message"
        self.server.files["/safety-2.mp4"] = new
        response = dict(self.server.manifest_response)
        response["safetyVideo"] = {"url": self.server.url + "/safety-2.mp4", "checksum": sha(new), "durationMs": 9000, "mimeType": "video/mp4"}
        self.server.manifest_response = response
        self.sync()
        self.assertEqual(self.server.paths_requested(), ["/api/devices/manifest", "/safety-2.mp4"])
        self.assertEqual(common.installed_safety()["checksum"], sha(new))
        self.assertEqual(common.installed_safety()["durationMs"], 9000)
        self.assertEqual(common.current_safety_file().read_bytes(), new)
        self.sync()
        self.assertEqual(self.server.paths_requested(), ["/api/devices/manifest"])

    def test_response_null_removes_safety(self):
        self.sync()
        response = dict(self.server.manifest_response)
        response["safetyVideo"] = None
        self.server.manifest_response = response
        self.sync()
        self.assertIsNone(common.installed_safety())
        self.assertFalse(common.current_safety_file().exists())

    def test_response_safety_used_for_new_loop_and_removed_asset_does_not_block(self):
        self.server.status_override["/safety-1.mp4"] = 404  # removed in settings after publishing
        self.sync()
        self.assertEqual(self.local_loop(), "L1")  # the loop still activates
        self.assertIsNone(common.installed_safety())
        self.assertIn("safety message unavailable", self.status()["error"])
        image = b"\xff\xd8safety-image"
        self.server.files["/safety.jpg"] = image
        self.server.files["/loop-2.mp4"] = os.urandom(10_000)
        self.publish("L2", "/loop-2.mp4", response_safety={"url": self.server.url + "/safety.jpg", "checksum": sha(image), "durationMs": 6000, "mimeType": "image/jpeg"})
        self.sync()
        self.assertEqual(self.local_loop(), "L2")
        self.assertEqual(common.installed_safety()["mimeType"], "image/jpeg")
        self.assertNotIn("/safety-1.mp4", self.server.paths_requested())
        self.assertEqual(common.current_safety_image_file().read_bytes(), image)

    def test_failing_safety_update_backs_off(self):
        self.sync()
        response = dict(self.server.manifest_response)
        response["safetyVideo"] = {"url": self.server.url + "/gone.mp4", "checksum": sha(b"x"), "durationMs": 1, "mimeType": "video/mp4"}
        self.server.manifest_response = response
        self.sync()
        self.assertEqual(self.status()["state"], "failed")
        self.sync()
        self.assertNotIn("/gone.mp4", self.server.paths_requested())
        self.assertEqual(common.installed_safety()["checksum"], sha(self.safety))  # old one kept


class TestServerInterval(SyncTestBase):
    """Finding 23 (sync half): interval from the heartbeat response, clamped."""

    def test_interval_from_server_config(self):
        self.assertEqual(self.agent.sync_interval(), 1800)
        common.atomic_write_json(common.SERVER_CONFIG_PATH, {"syncIntervalSeconds": 900})
        self.assertEqual(self.agent.sync_interval(), 900)
        common.atomic_write_json(common.SERVER_CONFIG_PATH, {"syncIntervalSeconds": 5})
        self.assertEqual(self.agent.sync_interval(), 300)
        common.atomic_write_json(common.SERVER_CONFIG_PATH, {"syncIntervalSeconds": 10**7})
        self.assertEqual(self.agent.sync_interval(), 86400)


if __name__ == "__main__":
    unittest.main()
