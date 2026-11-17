"""Regression tests for the health monitor: heartbeat robustness, log delivery and network facts.

Finding numbers refer to the device audit.
"""

import json
import os
import sys
import time
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402
from support import BASE, reset_base_dir  # noqa: E402

import common  # noqa: E402
import health_monitor  # noqa: E402
import netinfo  # noqa: E402
import requests  # noqa: E402
from log_queue import PlaybackLogQueue, normalize_legacy_entry, sanitize_entry  # noqa: E402
from sync_signal import consume_sync_request, decide_sync_reasons, request_heartbeat  # noqa: E402

OLD_MODES = {"journey", "silent", "idle"}
OLD_STATES = {"IDLE", "SAFETY", "JOURNEY", "SILENT", "WIND_DOWN", "DISABLED"}


def old_server_accepts(entry):
    """packages/shared playbackLogEntrySchema as deployed before contract 1.2.0."""
    import re
    if not isinstance(entry.get("playedAt"), str) or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$", entry["playedAt"]):
        return False
    if entry.get("slotPosition") is not None and not (isinstance(entry["slotPosition"], int) and 0 <= entry["slotPosition"] <= 9):
        return False
    if entry.get("contentType") not in (None, "ADVERTISEMENT", "FILLER"):
        return False
    if entry.get("mode") not in (None, *OLD_MODES):
        return False
    if entry.get("state") not in (None, *OLD_STATES):
        return False
    if entry.get("durationMs") is not None and not (isinstance(entry["durationMs"], int) and entry["durationMs"] >= 0):
        return False
    return True


class FakeResponse:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body if body is not None else {"ok": True}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")


class OldServer:
    """Behaves like today's /api/devices/playback-log: strict validation, 400 for the whole batch."""

    def __init__(self):
        self.stored = []
        self.calls = 0
        self.fail_with = None
        self.during_post = None

    def post(self, url, headers=None, data=None, timeout=None):
        self.calls += 1
        if self.during_post:
            self.during_post()
        if self.fail_with == "network":
            raise requests.ConnectionError("4G dropped")
        if self.fail_with:
            return FakeResponse(self.fail_with, {"error": "x"})
        body = json.loads(data)
        if not all(old_server_accepts(e) for e in body["logs"]):
            return FakeResponse(400, {"error": "Invalid request body"})
        self.stored.extend(body["logs"])
        return FakeResponse(200, {"ok": True, "count": len(body["logs"])})


def entry(i, **extra):
    return {"eventId": f"e-{i}", "loopId": "L", "playedAt": "2026-11-17T10:00:00.000Z", "type": "FILLER",
            "contentType": "FILLER", "mode": "journey", "state": "JOURNEY", "completedFull": True,
            "durationMs": 1000, "slotPosition": 0, **extra}


class HealthTestBase(unittest.TestCase):
    def setUp(self):
        reset_base_dir()
        self.hm = health_monitor.HealthMonitor()
        self.hm.logger.setLevel(100)
        self.server = OldServer()
        self.hm.session = self.server
        self.queue = self.hm.queue

    def queued(self):
        out = []
        for seg in self.queue.segments():
            out.extend(common.read_jsonl(seg))
        out.extend(common.read_jsonl(common.PLAYBACK_LOG_PATH))
        return out

    def dead(self):
        return common.read_jsonl(self.queue.dead_letter_path)


class TestLogUpload(HealthTestBase):
    def test_entries_written_during_upload_are_kept(self):
        """Finding 5."""
        for i in range(3):
            self.queue.append(entry(i))
        self.server.during_post = lambda: [self.queue.append(entry(100 + i)) for i in range(4)] and None
        self.hm.upload_logs()
        self.server.during_post = None
        self.assertEqual(len(self.server.stored), 3)
        self.assertEqual(sorted(e["eventId"] for e in self.queued()), [f"e-{100 + i}" for i in range(4)])
        self.hm.upload_logs()
        self.assertEqual(len(self.server.stored), 7)
        self.assertEqual(self.queued(), [])

    def test_rejected_batch_is_dead_lettered_not_resent(self):
        """Finding 8."""
        bad = dict(entry(0), playedAt="2026-11-17T10:00:00+01:00", slotPosition=None)
        bad["durationMs"] = -5  # something even the sanitiser keeps but the server refuses
        with mock.patch.object(health_monitor, "sanitize_entry", side_effect=lambda e: dict(e)):
            for i in range(250):
                self.queue.append(bad if i == 0 else entry(i))
            self.hm.upload_logs()
        self.assertEqual(len(self.server.stored), 50)  # second segment of 50 went through
        self.assertEqual(len(self.dead()), 200)  # first segment (with the bad entry) dead-lettered
        calls = self.server.calls
        self.hm.upload_logs()
        self.assertEqual(self.server.calls, calls)  # nothing left: never re-sent

    def test_sanitiser_keeps_one_odd_value_from_rejecting_a_batch(self):
        odd = entry(1, slotPosition=12, mode="weird", state="NEW", contentType="STATIC_IMAGE",
                    playedAt="2026-11-17T10:00:00.123456+00:00")
        clean = sanitize_entry(odd)
        self.assertTrue(old_server_accepts(clean))
        self.assertEqual(clean["playedAt"], "2026-11-17T10:00:00.123Z")
        self.assertIsNone(sanitize_entry({"type": "X"}))  # no time at all: cannot be sent

    def test_continuous_mode_downgraded_for_old_server(self):
        for i in range(3):
            self.queue.append(entry(i, mode="continuous"))
        self.hm.upload_logs()
        self.assertEqual(self.server.calls, 2)  # 400, then the compatibility retry
        self.assertEqual({e["mode"] for e in self.server.stored}, {"journey"})
        self.assertEqual(self.queued(), [])
        self.queue.append(entry(9, mode="continuous"))
        self.hm.upload_logs()
        self.assertEqual(self.server.calls, 3)  # remembered: no wasted 400 per batch

    def test_new_server_rejected_indexes_dead_lettered(self):
        def post(url, headers=None, data=None, timeout=None):
            logs = json.loads(data)["logs"]
            return FakeResponse(200, {"ok": True, "accepted": len(logs) - 1, "duplicates": 0,
                                      "rejected": [{"index": 1, "reason": "bad asset"}]})
        self.hm.session = types.SimpleNamespace(post=post)
        for i in range(3):
            self.queue.append(entry(i, mode="continuous"))
        self.hm.upload_logs()
        self.assertEqual(self.queued(), [])
        dead = self.dead()
        self.assertEqual(len(dead), 1)
        self.assertEqual(dead[0]["entry"]["eventId"], "e-1")

    def test_retryable_failures_keep_the_batch_with_backoff(self):
        for status in ("network", 401, 403, 404, 429, 500, 503):
            reset_base_dir()
            self.setUp()
            self.queue.append(entry(1))
            self.server.fail_with = status
            self.hm.upload_logs()
            self.assertEqual(len(self.queued()), 1, status)
            self.assertGreater(self.hm.upload_retry_at, time.time())
            calls = self.server.calls
            self.hm.upload_logs()  # inside backoff: no request
            self.assertEqual(self.server.calls, calls)
            self.server.fail_with = None
            self.hm.upload_retry_at = 0
            self.hm.upload_logs()
            self.assertEqual(self.queued(), [], status)

    def test_resend_after_lost_response_carries_same_event_ids(self):
        self.queue.append(entry(1))
        real = self.server.post

        def post_then_drop(*a, **k):
            real(*a, **k)
            raise requests.ConnectionError("lost response")
        self.hm.session = types.SimpleNamespace(post=post_then_drop)
        self.hm.upload_logs()
        self.hm.session = self.server
        self.hm.upload_retry_at = 0
        self.hm.upload_logs()
        ids = [e["eventId"] for e in self.server.stored]
        self.assertEqual(ids, ["e-1", "e-1"])  # new server de-duplicates on (device, eventId)

    def test_upload_every_cycle_when_queued(self):
        """Finding 19: no more hourly-only upload."""
        self.queue.append(entry(1))
        with mock.patch.object(self.hm, "send_heartbeat"), mock.patch.object(self.hm, "wait", side_effect=StopIteration):
            with self.assertRaises(StopIteration):
                self.hm.run()
        self.assertEqual(len(self.server.stored), 1)

    def test_queue_is_bounded_and_says_so(self):
        """Finding 19: weeks without signal must not fill the disk."""
        queue = PlaybackLogQueue(common.LOG_DIR, max_bytes=60_000, logger=mock.Mock())
        for i in range(2000):
            queue.append(entry(i))
        queue.rotate()
        total = sum(p.stat().st_size for p in queue.segments())
        self.assertLessEqual(total, 60_000)
        status = queue.status()
        self.assertGreater(status["dropped"], 0)
        self.assertTrue(queue.logger.warning.called)
        remaining = [e["eventId"] for s in queue.segments() for e in common.read_jsonl(s)]
        self.assertEqual(remaining[-1], "e-1999")  # oldest dropped, newest kept

    def test_append_can_flush_to_disk(self):
        with mock.patch("log_queue.os.fsync") as fsync:
            self.queue.append(entry(1), durable=True)
            self.assertTrue(fsync.called)
            fsync.reset_mock()
            self.queue.append(entry(2))
            self.assertFalse(fsync.called)
            self.queue.flush()
            self.assertTrue(fsync.called)

    def test_half_written_last_line_does_not_swallow_the_next_entry(self):
        common.LOG_DIR.mkdir(parents=True, exist_ok=True)
        common.PLAYBACK_LOG_PATH.write_text(json.dumps(entry(1)) + "\n" + '{"eventId":"e-2","pla')
        self.queue.append(entry(3))
        self.assertEqual([e["eventId"] for e in self.queued()], ["e-1", "e-3"])

    def test_old_firmware_log_on_disk_is_uploaded(self):
        """First boot after update: the 1.0/1.1 log has no eventIds and stills logged as adverts."""
        old = [
            {"ts": "2026-11-16T09:00:00.1Z", "playedAt": "2026-11-16T09:00:00.123456Z", "slotPosition": 0, "contentType": "ADVERTISEMENT",
             "type": "ADVERTISEMENT", "event": None, "assetId": "video-ad", "mode": "idle", "state": "IDLE", "completedFull": True,
             "durationMs": 60000, "journeyId": None, "deviceSerial": "X", "location": None},
            {"ts": "2026-11-16T09:01:00Z", "playedAt": "2026-11-16T09:01:00Z", "slotPosition": 0, "contentType": "ADVERTISEMENT",
             "type": "ADVERTISEMENT", "event": None, "assetId": "video-ad", "mode": "journey", "state": "JOURNEY", "completedFull": True,
             "durationMs": 12000, "journeyId": "j-1", "deviceSerial": "X", "location": None},
            {"ts": "2026-11-16T09:01:00Z", "playedAt": "2026-11-16T09:01:00Z", "type": None, "event": "JOURNEY_START", "mode": "idle",
             "state": "IDLE", "completedFull": True, "durationMs": 0},
        ]
        common.LOG_DIR.mkdir(parents=True, exist_ok=True)
        common.rewrite_jsonl(common.PLAYBACK_LOG_PATH, old)
        self.hm.upload_logs()
        stored = self.server.stored
        self.assertEqual(len(stored), 3)
        self.assertTrue(all(e.get("eventId") for e in stored))
        self.assertEqual((stored[0]["type"], stored[0]["contentType"], stored[0]["assetId"]), ("STATIC_IMAGE", None, None))
        self.assertEqual((stored[1]["type"], stored[1]["assetId"]), ("ADVERTISEMENT", "video-ad"))
        self.assertEqual(normalize_legacy_entry({"eventId": "keep"}), {"eventId": "keep"})


class TestHeartbeat(HealthTestBase):
    def setUp(self):
        super().setUp()
        self.sent = []

        def post(url, headers=None, data=None, timeout=None):
            self.sent.append(json.loads(data))
            return FakeResponse(200, self.response)
        self.response = {"ok": True, "deviceId": "d", "expectedLoopId": None, "expectedChecksum": None, "disabled": False}
        self.hm.session = types.SimpleNamespace(post=post)
        self.hm.network_snapshot = lambda: {"networkType": "ethernet", "signalPercent": 62, "signalDbm": None, "modem": {}}
        self.hm.current_location = lambda network=None: None

    def test_heartbeat_survives_bad_local_files(self):
        """Finding 10: a zero-length manifest used to stop every heartbeat."""
        common.CURRENT_DIR.mkdir(parents=True, exist_ok=True)
        common.current_manifest_path().write_text("")
        common.PLAYER_STATE_PATH.write_text("{")
        common.SYNC_STATUS_PATH.write_text("\x00")
        (common.CURRENT_DIR / "safety.json").write_text("[")
        self.hm.network_snapshot = lambda: 1 / 0
        self.hm.cpu_temp_c = lambda: 1 / 0
        self.hm.send_heartbeat()
        hb = self.sent[0]
        self.assertIsNone(hb["currentLoopId"])
        self.assertEqual(hb["networkType"], "unknown")
        self.assertEqual(hb["playerStatus"], "unknown")

    def test_stale_player_state_reports_error(self):
        """Finding 18."""
        common.atomic_write_json(common.PLAYER_STATE_PATH, {"status": "playing", "updatedAt": "2026-01-01T00:00:00Z", "trigger": "always"})
        self.hm.send_heartbeat()
        self.assertEqual(self.sent[-1]["playerStatus"], "error")
        common.atomic_write_json(common.PLAYER_STATE_PATH, {"status": "playing", "updatedAt": common.utc_now_iso(), "trigger": "always", "state": "SAFETY"})
        self.hm.send_heartbeat()
        self.assertEqual((self.sent[-1]["playerStatus"], self.sent[-1]["playbackTrigger"], self.sent[-1]["playerState"]), ("playing", "always", "SAFETY"))

    def test_post_sync_heartbeat_is_a_full_heartbeat(self):
        """Finding 18: the sync agent asks for a heartbeat instead of sending a bare one."""
        request_heartbeat("activated")
        started = time.monotonic()
        self.hm.wait(60)
        self.assertLess(time.monotonic() - started, 1)

    def test_signal_and_network_type_per_contract(self):
        """Finding 15."""
        self.hm.send_heartbeat()
        hb = self.sent[-1]
        self.assertIsNone(hb["signalStrength"])  # a percentage is never sent as dBm
        self.assertEqual(hb["signalPercent"], 62)
        self.assertEqual(hb["networkType"], "ethernet")
        self.hm.network_snapshot = lambda: {"networkType": "5g?", "signalDbm": -97, "signalPercent": None, "modem": {}}
        self.hm.send_heartbeat()
        self.assertEqual((self.sent[-1]["networkType"], self.sent[-1]["signalStrength"]), ("unknown", -97))

    def test_sync_and_safety_reported(self):
        common.atomic_write_json(common.SYNC_STATUS_PATH, {"state": "failed", "error": "x" * 400, "failedLoopId": "L9",
                                                            "since": "s", "lastSyncedAt": None, "nextRetryAt": "n", "failures": {"a": 1}})
        common.CURRENT_DIR.mkdir(parents=True, exist_ok=True)
        (common.CURRENT_DIR / "safety.mp4").write_bytes(b"s")
        common.atomic_write_json(common.CURRENT_DIR / "safety.json", {"safetyVideo": {"url": "u", "checksum": "sha256:abc", "mimeType": "video/mp4"}})
        self.hm.send_heartbeat()
        hb = self.sent[-1]
        self.assertEqual(hb["safetyChecksum"], "sha256:abc")
        self.assertEqual(len(hb["sync"]["error"]), 300)
        self.assertEqual(set(hb["sync"]), {"state", "error", "failedLoopId", "since", "lastSyncedAt", "nextRetryAt"})

    def test_adopts_server_intervals(self):
        """Finding 23."""
        self.response = {**self.response, "config": {"heartbeatIntervalSeconds": 10, "syncIntervalSeconds": 999999}}
        self.hm.send_heartbeat()
        self.assertEqual(self.hm.heartbeat_interval(), 60)
        self.assertEqual(common.effective_interval(1800, "syncIntervalSeconds", common.SYNC_INTERVAL_RANGE), 86400)
        self.response = {**self.response, "config": {"heartbeatIntervalSeconds": 120, "syncIntervalSeconds": 600}}
        self.hm.send_heartbeat()
        self.assertEqual(self.hm.heartbeat_interval(), 120)
        self.response = {k: v for k, v in self.response.items() if k != "config"}  # old server
        self.hm.send_heartbeat()
        self.assertEqual(self.hm.heartbeat_interval(), 300)

    def test_expected_safety_checksum_requests_sync(self):
        """Finding 11."""
        self.hm.sync_requester.min_interval_s = 0
        self.hm.send_heartbeat()
        self.assertIsNone(consume_sync_request())  # key absent: no opinion
        self.response = {**self.response, "expectedSafetyChecksum": "sha256:new"}
        self.hm.send_heartbeat()
        self.assertEqual(consume_sync_request()["reasons"], ["safety"])
        self.response = {**self.response, "expectedSafetyChecksum": None}
        self.hm.send_heartbeat()
        self.assertIsNone(consume_sync_request())  # no safety installed and none expected

    def test_decide_safety_reason(self):
        base = {"expectedLoopId": "a", "expectedChecksum": "c"}
        self.assertEqual(decide_sync_reasons(base, "a", "c", False, local_safety_checksum="x"), [])
        self.assertEqual(decide_sync_reasons({**base, "expectedSafetyChecksum": None}, "a", "c", False, local_safety_checksum="x"), ["safety"])
        self.assertEqual(decide_sync_reasons({**base, "expectedSafetyChecksum": "x"}, "a", "c", False, local_safety_checksum="x"), [])
        self.assertEqual(decide_sync_reasons({**base, "expectedSafetyChecksum": "y"}, "a", "c", False), [])  # caller did not say


class TestSystemFacts(HealthTestBase):
    def test_cpu_temp_tolerates_x86_thermal_zones(self):
        """Finding 24."""
        root = BASE / "thermal"
        zones = {"thermal_zone0": ("acpitz", None), "thermal_zone1": ("iwlwifi_1", "-40000"), "thermal_zone2": ("x86_pkg_temp", "47000")}
        for name, (ztype, temp) in zones.items():
            (root / name).mkdir(parents=True, exist_ok=True)
            (root / name / "type").write_text(ztype + "\n")
            if temp is not None:
                (root / name / "temp").write_text(temp + "\n")
            else:
                (root / name / "temp").mkdir()  # reading it raises OSError (EISDIR), like EIO on real zones
        self.assertEqual(self.hm.cpu_temp_c(root), 47.0)
        with mock.patch.object(health_monitor.psutil, "sensors_temperatures", side_effect=OSError, create=True):
            self.assertIsNone(self.hm.cpu_temp_c(BASE / "none"))

    def test_firmware_version(self):
        self.assertEqual(self.hm.firmware_version(), "1.2.0")
        self.assertEqual((support.DEVICE_DIR / "VERSION").read_text().strip(), "1.2.0")
        self.assertEqual(common.FIRMWARE_VERSION, "1.2.0")


class TestNetworkParsing(unittest.TestCase):
    """Finding 15."""

    def test_default_route(self):
        text = ("Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n"
                "enp1s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\n"
                "wwan0\t00000000\t01000A0A\t0003\t0\t0\t50\t00000000\n"
                "wwan0\t0000000A\t00000000\t0001\t0\t0\t50\t000000FF\n")
        self.assertEqual(netinfo.default_route_interface(text), "wwan0")
        self.assertIsNone(netinfo.default_route_interface("Iface\n"))

    def test_classify(self):
        root = BASE / "net"
        (root / "wlp2s0" / "wireless").mkdir(parents=True, exist_ok=True)
        (root / "enx0011").mkdir(parents=True, exist_ok=True)
        (root / "enx0011" / "device").mkdir(parents=True, exist_ok=True)
        driver = root / "drivers" / "cdc_ether"
        driver.mkdir(parents=True, exist_ok=True)
        if not (root / "enx0011" / "device" / "driver").exists():
            os.symlink(driver, root / "enx0011" / "device" / "driver")
        self.assertEqual(netinfo.classify_interface("wlp2s0", root), "wifi")
        self.assertEqual(netinfo.classify_interface("enx0011", root), "4g")  # modem in ECM mode
        self.assertEqual(netinfo.classify_interface("enp1s0", root), "ethernet")
        self.assertEqual(netinfo.classify_interface("wwan0", root), "4g")
        self.assertEqual(netinfo.classify_interface("cdc-wdm0", root, {"cdc-wdm0": "gsm"}), "4g")
        self.assertEqual(netinfo.classify_interface("tun0", root), "unknown")
        self.assertEqual(netinfo.classify_interface(None, root), "unknown")

    def test_nmcli_multiple_devices_do_not_overwrite(self):
        text = ("GENERAL.DEVICE:cdc-wdm0\nGENERAL.TYPE:gsm\nWWAN.SIGNAL:62\nWWAN.OPERATOR:EE\n\n"
                "GENERAL.DEVICE:enp1s0\nGENERAL.TYPE:ethernet\nWWAN.SIGNAL:\nWWAN.OPERATOR:\n\n"
                "GENERAL.DEVICE:lo\nGENERAL.TYPE:loopback\n")
        blocks = netinfo.parse_nmcli_device_show(text)
        self.assertEqual(len(blocks), 3)
        self.assertEqual(netinfo.nmcli_wwan_signal(blocks), (62, "EE"))
        status = netinfo.parse_nmcli_device_status("wwan0:gsm:connected\nenp1s0:ethernet:unavailable\nlo:loopback:unmanaged (externally)\n")
        self.assertEqual(status["wwan0"], {"type": "gsm", "state": "connected"})
        self.assertEqual(netinfo.split_nmcli_terse(r"a\:b:c"), ["a:b", "c"])
        self.assertEqual(netinfo.parse_nmcli_wifi_signal(" :40\n*:71\n"), 71)

    def test_mmcli(self):
        listing = netinfo.parse_mmcli_kv("modem-list.length   : 1\nmodem-list.value[1] : /org/freedesktop/ModemManager1/Modem/0\n")
        self.assertEqual(netinfo.mmcli_first_modem(listing), "/org/freedesktop/ModemManager1/Modem/0")
        info = netinfo.parse_mmcli_kv(
            "modem.generic.state : connected\nmodem.generic.signal-quality.value : 62\nmodem.generic.signal-quality.recent : yes\n"
            "modem.generic.access-technologies.length : 1\nmodem.generic.access-technologies.value[1] : lte\nmodem.3gpp.operator-name : EE\n")
        self.assertEqual(netinfo.mm_modem_summary(info), {"signalPercent": 62, "technology": "lte", "operator": "EE", "state": "connected"})
        signal = netinfo.parse_mmcli_kv("modem.signal.refresh.rate : 10\nmodem.signal.lte.rssi : -65.00\nmodem.signal.lte.rsrp : -95.00\nmodem.signal.umts.rscp : --\n")
        self.assertEqual(netinfo.mm_signal_dbm(signal), -95)
        self.assertIsNone(netinfo.mm_signal_dbm(netinfo.parse_mmcli_kv("modem.signal.lte.rsrp : --\n")))
        location = netinfo.parse_mmcli_kv("modem.location.3gpp.mcc : 234\nmodem.location.3gpp.mnc : 10\nmodem.location.3gpp.lac : 0000\n"
                                          "modem.location.3gpp.tac : 003039\nmodem.location.3gpp.cid : 01A2B3C4\nmodem.location.gps.latitude : --\n")
        self.assertEqual(netinfo.mm_cell_location(location, "lte"),
                         {"method": "cell_tower", "radio": "lte", "mcc": 234, "mnc": 10, "lac": 0x3039, "cellId": 0x1A2B3C4, "source": "modemmanager"})
        self.assertIsNone(netinfo.mm_gps_fix(location))
        self.assertIsNone(netinfo.mm_cell_location({}, "lte"))
        for junk in ("", "garbage", "a : b : c\n::\n"):
            netinfo.parse_mmcli_kv(junk)


class TestModemPorts(HealthTestBase):
    """Finding 16."""

    def test_candidates_include_x86_internal_modem_ports(self):
        names = [p.name for p in health_monitor.AT_PORT_CANDIDATES]
        for name in ("wwan0at0", "ttyUSB2", "ttyACM0"):
            self.assertIn(name, names)

    def test_modemmanager_running_means_no_raw_at_access(self):
        port = BASE / "ttyFAKE"
        port.write_text("")
        calls = []
        self.hm.run_at_command = lambda p, c, t=1.5: calls.append(c) or ""
        with mock.patch.object(health_monitor, "AT_PORT_CANDIDATES", [port]):
            self.hm._mm_running = True
            self.assertIsNone(self.hm.current_location({"modem": {}}))
            self.assertEqual(calls, [])
            self.hm._mm_running = False
            self.hm.current_location({"modem": {}})
            self.assertTrue(calls)

    def test_explicit_port_and_none(self):
        self.hm.config.raw["modem"] = {"atPort": "/dev/ttyXYZ9"}
        self.assertEqual(self.hm.at_port_candidates(), [Path("/dev/ttyXYZ9")])
        self.hm._mm_running = True
        self.assertTrue(self.hm.at_ports_allowed())
        self.hm.config.raw["modem"] = {"atPort": "none"}
        self.assertFalse(self.hm.at_ports_allowed())

    def test_modemmanager_cell_used_for_location(self):
        self.hm._mm_running = True
        cell = {"method": "cell_tower", "radio": "lte", "mcc": 234, "mnc": 10, "lac": 1, "cellId": 2}
        loc = self.hm.current_location({"modem": {"cell": cell, "signalDbm": -90}})
        self.assertEqual((loc["cellId"], loc["signalStrength"]), (2, -90))

    def test_network_snapshot_never_raises(self):
        with mock.patch.object(self.hm, "run_command", side_effect=lambda args: "garbage:::\n"):
            snapshot = self.hm.network_snapshot()
        self.assertIn(snapshot["networkType"], netinfo.NETWORK_TYPES)


if __name__ == "__main__":
    unittest.main()
