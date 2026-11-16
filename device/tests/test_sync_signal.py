import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("ORISON_BASE_DIR", tempfile.mkdtemp())

from common import DeviceConfig  # noqa: E402
from sync_signal import SyncRequester, consume_sync_request, decide_sync_reasons  # noqa: E402


class Decide(unittest.TestCase):
    def test_old_server_no_opinion(self):
        self.assertEqual(decide_sync_reasons({"ok": True, "deviceId": "x"}, "a", "c", False), [])
        self.assertEqual(decide_sync_reasons(None, "a", "c", False), [])
        self.assertEqual(decide_sync_reasons("junk", "a", "c", False), [])
        self.assertEqual(decide_sync_reasons({"expectedLoopId": None, "expectedChecksum": None}, "a", "c", False), [])

    def test_agree(self):
        r = {"expectedLoopId": "a", "expectedChecksum": "c", "disabled": False}
        self.assertEqual(decide_sync_reasons(r, "a", "c", False), [])

    def test_loop_and_checksum_differ(self):
        r = {"expectedLoopId": "b", "expectedChecksum": "d", "disabled": False}
        self.assertEqual(decide_sync_reasons(r, "a", "c", False), ["loopId", "checksum"])

    def test_no_local_manifest(self):
        self.assertEqual(decide_sync_reasons({"expectedLoopId": "b"}, None, None, None), ["loopId"])

    def test_disabled(self):
        self.assertEqual(decide_sync_reasons({"disabled": True}, "a", "c", False), ["disabled"])
        self.assertEqual(decide_sync_reasons({"disabled": False}, "a", "c", True), ["disabled"])
        self.assertEqual(decide_sync_reasons({"disabled": True}, "a", "c", None), [])  # player state unknown
        self.assertEqual(decide_sync_reasons({"disabled": "yes"}, "a", "c", False), [])


class Requester(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "runtime" / "sync_request.json"
        self.t = 0.0
        self.req = SyncRequester(self.path, 120, lambda: self.t)

    def test_writes_and_consumes_once(self):
        self.assertTrue(self.req.maybe_request(["loopId"], {"expectedLoopId": "b"}))
        data = consume_sync_request(self.path)
        self.assertEqual(data["reasons"], ["loopId"])
        self.assertIsNone(consume_sync_request(self.path))

    def test_no_reasons_no_file(self):
        self.assertFalse(self.req.maybe_request([]))
        self.assertFalse(self.path.exists())

    def test_rate_limit(self):
        self.assertTrue(self.req.maybe_request(["loopId"]))
        consume_sync_request(self.path)
        self.t = 119
        self.assertFalse(self.req.maybe_request(["loopId"]))
        self.assertFalse(self.path.exists())
        self.t = 121
        self.assertTrue(self.req.maybe_request(["loopId"]))

    def test_pending_not_rewritten(self):
        self.assertTrue(self.req.maybe_request(["loopId"]))
        self.t = 500
        self.assertFalse(self.req.maybe_request(["checksum"]))
        self.assertEqual(consume_sync_request(self.path)["reasons"], ["loopId"])

    def test_corrupt_file_is_consumed(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{not json")
        self.assertEqual(consume_sync_request(self.path), {})
        self.assertFalse(self.path.exists())


class ConfigTolerance(unittest.TestCase):
    def test_gps_enabled(self):
        base = {"device": {}}
        self.assertTrue(DeviceConfig(base).gps_enabled)
        self.assertTrue(DeviceConfig({"location": None}).gps_enabled)
        self.assertTrue(DeviceConfig({"location": {}}).gps_enabled)
        self.assertFalse(DeviceConfig({"location": {"gpsEnabled": False}}).gps_enabled)
        self.assertFalse(DeviceConfig({"location": {"gpsEnabled": "false"}}).gps_enabled)


class SyncAgentWait(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.modules.setdefault("requests", types.SimpleNamespace(Session=lambda: None, RequestException=Exception))
        import sync_agent
        cls.sync_agent = sync_agent

    def make(self):
        agent = self.sync_agent.SyncAgent.__new__(self.sync_agent.SyncAgent)
        agent.logger = types.SimpleNamespace(info=lambda *a: None)
        return agent

    def test_sleeps_in_short_steps_and_times_out(self):
        agent = self.make()
        t = [0.0]
        sleeps = []

        def sleep(s):
            sleeps.append(s)
            t[0] += s

        with unittest.mock.patch.object(self.sync_agent, "SYNC_REQUEST_PATH", Path(tempfile.mkdtemp()) / "x.json"):
            self.assertFalse(agent.wait_for_next_sync(23, sleep, lambda: t[0]))
        self.assertTrue(all(s <= 5 for s in sleeps))
        self.assertAlmostEqual(sum(sleeps), 23)

    def test_wakes_early_on_request(self):
        agent = self.make()
        path = Path(tempfile.mkdtemp()) / "x.json"
        t = [0.0]

        def sleep(s):
            t[0] += s
            if t[0] >= 10:
                path.write_text('{"reasons":["loopId"]}')

        with unittest.mock.patch.object(self.sync_agent, "SYNC_REQUEST_PATH", path):
            self.assertTrue(agent.wait_for_next_sync(1800, sleep, lambda: t[0]))
        self.assertLessEqual(t[0], 15)
        self.assertFalse(path.exists())


import unittest.mock  # noqa: E402

if __name__ == "__main__":
    unittest.main()
