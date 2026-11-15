import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("ORISON_BASE_DIR", tempfile.mkdtemp())

from modem import GpsReader, build_gps_location, parse_qeng_serving_cell, parse_qgps_state, parse_qgpsloc  # noqa: E402

LTE = '+QENG: "servingcell","NOCONN","LTE","FDD",234,10,1A2B3C4,123,1300,3,5,5,3039,-95,-10,-65,12,32'
LTE_CONNECT = '+QENG: "servingcell","CONNECT","LTE","TDD",310,260,0001F40,10,40000,41,3,3,00A1,-101,-12,-70,5,20'
WCDMA = '+QENG: "servingcell","NOCONN","WCDMA",234,15,2B5C,01A2F3D,10787,100,0,-87,-6,-,-,-,-'
GSM = '+QENG: "servingcell","LIMSRV","GSM",234,30,0D05,7E3F,25,22,8,-71,-,-,-,-,-'


class ParseCell(unittest.TestCase):
    def test_lte_hex_to_decimal(self):
        r = parse_qeng_serving_cell(LTE + "\r\n\r\nOK\r\n")
        self.assertEqual(r["radio"], "lte")
        self.assertEqual((r["mcc"], r["mnc"]), (234, 10))
        self.assertEqual(r["cellId"], 0x1A2B3C4)
        self.assertEqual(r["lac"], 0x3039)  # TAC, not the PCID
        self.assertEqual(r["signalStrength"], -95)  # RSRP
        self.assertEqual(r["method"], "cell_tower")
        self.assertEqual(r["raw"], LTE)

    def test_lte_connect_tdd_leading_zero_mnc(self):
        r = parse_qeng_serving_cell(LTE_CONNECT)
        self.assertEqual((r["mcc"], r["mnc"], r["cellId"], r["lac"]), (310, 260, 0x1F40, 0xA1))
        self.assertEqual(r["signalStrength"], -101)

    def test_wcdma(self):
        r = parse_qeng_serving_cell(WCDMA)
        self.assertEqual(r["radio"], "wcdma")
        self.assertEqual((r["mcc"], r["mnc"], r["lac"], r["cellId"]), (234, 15, 0x2B5C, 0x1A2F3D))
        self.assertEqual(r["signalStrength"], -87)  # RSCP

    def test_gsm_limsrv(self):
        r = parse_qeng_serving_cell(GSM)
        self.assertEqual(r["radio"], "gsm")
        self.assertEqual((r["lac"], r["cellId"]), (0xD05, 0x7E3F))
        self.assertEqual(r["signalStrength"], -71)

    def test_gsm_rxlev_index(self):
        r = parse_qeng_serving_cell(GSM.replace(",-71,", ",39,"))
        self.assertEqual(r["signalStrength"], -71)

    def test_search_state(self):
        self.assertIsNone(parse_qeng_serving_cell('+QENG: "servingcell","SEARCH"\r\nOK'))

    def test_malformed_never_raises(self):
        for bad in [
            "", "OK", "ERROR", None, 12,
            '+QENG: "servingcell"',
            '+QENG: "servingcell","NOCONN","LTE"',
            '+QENG: "servingcell","NOCONN","LTE","FDD",234,10,-,-,-,-,-,-,-,-',
            '+QENG: "servingcell","NOCONN","LTE","FDD",234,10,ZZZ,1,2,3,4,5,6,-90',
            '+QENG: "servingcell","NOCONN","NR5G-SA","FDD",234,10',
            '+QENG: "servingcell",,,,,,,',
            '+QENG: "servingcell","NOCONN","LTE","FDD",234,10,1A2B3C4,1,2,3,4,5',
        ]:
            self.assertIsNone(parse_qeng_serving_cell(bad), bad)

    def test_missing_signal_still_returns_cell(self):
        r = parse_qeng_serving_cell('+QENG: "servingcell","NOCONN","LTE","FDD",234,10,1A2B3C4,1,2,3,4,5,3039,-,-,-')
        self.assertEqual(r["cellId"], 0x1A2B3C4)
        self.assertIsNone(r["signalStrength"])
        r = parse_qeng_serving_cell('+QENG: "servingcell","NOCONN","LTE","FDD",234,10,1A2B3C4,1,2,3,4,5,3039')
        self.assertIsNone(r["signalStrength"])

    def test_picks_first_valid_line(self):
        r = parse_qeng_serving_cell('+QENG: "servingcell","SEARCH"\n' + GSM)
        self.assertEqual(r["radio"], "gsm")


FIX = "+QGPSLOC: 100112.000,51.50720,-0.12760,1.1,45.0,3,0.00,23.4,12.6,151126,08"
NOW = datetime(2026, 11, 15, 10, 5, tzinfo=timezone.utc)


class ParseGps(unittest.TestCase):
    def test_fix(self):
        status, fix = parse_qgpsloc(FIX + "\r\nOK", NOW)
        self.assertEqual(status, "ok")
        self.assertEqual((fix["lat"], fix["lng"], fix["hdop"], fix["speedKmh"]), (51.5072, -0.1276, 1.1, 23.4))
        self.assertEqual(fix["fixTime"], "2026-11-15T10:01:12Z")
        self.assertEqual(fix["accuracyM"], 6)

    def test_hemisphere_suffix(self):
        _, fix = parse_qgpsloc(FIX.replace("51.50720,-0.12760", "33.86S,151.2E"), NOW)
        self.assertEqual((fix["lat"], fix["lng"]), (-33.86, 151.2))

    def test_no_fix_516(self):
        self.assertEqual(parse_qgpsloc("+CME ERROR: 516", NOW), ("no_fix", None))

    def test_not_active_505(self):
        self.assertEqual(parse_qgpsloc("+CME ERROR: 505", NOW), ("not_active", None))

    def test_errors(self):
        for r in ["", "ERROR", "+CME ERROR: 3", "+QGPSLOC: garbage", None]:
            self.assertEqual(parse_qgpsloc(r, NOW)[0], "error", r)

    def test_zero_fix_type_is_no_fix(self):
        self.assertEqual(parse_qgpsloc(FIX.replace(",3,0.00,", ",0,0.00,"), NOW)[0], "no_fix")

    def test_gnss_state(self):
        self.assertTrue(parse_qgps_state("+QGPS: 1\r\nOK"))
        self.assertFalse(parse_qgps_state("+QGPS: 0\r\nOK"))
        self.assertIsNone(parse_qgps_state("ERROR"))
        self.assertIsNone(parse_qgps_state(""))


class FakeModem:
    """Scripted AT responses; each entry is a response string or list consumed in order."""

    def __init__(self, script, clock=None, cost=0.0):
        self.script = {k: (list(v) if isinstance(v, list) else [v]) for k, v in script.items()}
        self.calls = []
        self.clock = clock
        self.cost = cost

    def __call__(self, command, timeout):
        self.calls.append(command)
        if self.clock:
            self.clock.t += self.cost
        queue = self.script.get(command, [""])
        return queue.pop(0) if len(queue) > 1 else queue[0]


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def reader(modem, clock, **kw):
    return GpsReader(modem, monotonic=clock, wall_now=lambda: NOW, **kw)


class GpsReaderTests(unittest.TestCase):
    def test_enables_gnss_then_reads(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "+QGPS: 0\r\nOK", "AT+QGPS=1": "OK", "AT+QGPSLOC=2": FIX})
        fix = reader(m, clock).read()
        self.assertEqual(fix["lat"], 51.5072)
        self.assertEqual(m.calls, ["AT+QGPS?", "AT+QGPS=1", "AT+QGPSLOC=2"])

    def test_already_on_is_checked_once(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "+QGPS: 1\r\nOK", "AT+QGPSLOC=2": FIX})
        r = reader(m, clock)
        r.read()
        r.read()
        self.assertEqual(m.calls.count("AT+QGPS?"), 1)

    def test_session_ongoing_504_ok(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "+QGPS: 0", "AT+QGPS=1": "+CME ERROR: 504", "AT+QGPSLOC=2": FIX})
        self.assertIsNotNone(reader(m, clock).read())

    def test_no_fix_is_not_an_error(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "+QGPS: 1", "AT+QGPSLOC=2": "+CME ERROR: 516"})
        r = reader(m, clock)
        self.assertIsNone(r.read())
        self.assertEqual(r.consecutive_failures, 0)
        clock.t += 1
        r.read()
        self.assertEqual(m.calls.count("AT+QGPSLOC=2"), 2)  # no backoff

    def test_last_good_fix_reused_with_real_fixtime_then_expires(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "+QGPS: 1", "AT+QGPSLOC=2": [FIX, "+CME ERROR: 516"]})
        r = reader(m, clock)
        first = r.read()
        clock.t += 300
        again = r.read()
        self.assertEqual(again["fixTime"], first["fixTime"])
        self.assertEqual(again["lat"], first["lat"])
        clock.t += 301  # 601s since fix, window is 600s
        self.assertIsNone(r.read())

    def test_cache_used_on_hard_error_too(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "+QGPS: 1", "AT+QGPSLOC=2": [FIX, "ERROR"]})
        r = reader(m, clock)
        r.read()
        clock.t += 60
        self.assertIsNotNone(r.read())

    def test_backoff_on_unsupported_modem(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "ERROR"})
        r = reader(m, clock)
        self.assertIsNone(r.read())
        n = len(m.calls)
        for _ in range(4):  # heartbeats during backoff must not touch the port
            clock.t += 60
            self.assertIsNone(r.read())
        self.assertEqual(len(m.calls), n)
        clock.t += 61
        r.read()
        self.assertEqual(len(m.calls), n + 1)

    def test_backoff_grows_and_caps_and_resets(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": "", })
        r = reader(m, clock)
        delays = []
        for _ in range(6):
            clock.t = r.backoff_until + 1
            r.read()
            delays.append(r.backoff_until - clock.t)
        self.assertEqual(delays[:3], [300, 600, 1200])
        self.assertEqual(delays[-1], 3600)
        m.script["AT+QGPS?"] = ["+QGPS: 1"]
        m.script["AT+QGPSLOC=2"] = [FIX]
        clock.t = r.backoff_until + 1
        self.assertIsNotNone(r.read())
        self.assertEqual(r.consecutive_failures, 0)

    def test_disabled_never_touches_port(self):
        clock = Clock()
        m = FakeModem({})
        self.assertIsNone(reader(m, clock, enabled=False).read())
        self.assertEqual(m.calls, [])

    def test_budget_limits_blocking(self):
        clock = Clock()
        # each command "takes" 1.2s of the injected clock; budget 2s => at most 2 commands issued
        m = FakeModem({"AT+QGPS?": "+QGPS: 0", "AT+QGPS=1": "OK", "AT+QGPSLOC=2": FIX}, clock, cost=1.2)
        r = reader(m, clock)
        self.assertIsNone(r.read())
        self.assertLessEqual(len(m.calls), 2)
        self.assertEqual(r.consecutive_failures, 0)  # running out of time is not an error
        clock.t += 1
        r.read()  # progresses on the next heartbeat

    def test_exception_in_at_backs_off(self):
        clock = Clock()

        def boom(cmd, t):
            raise OSError("tty gone")

        r = reader(boom, clock)
        self.assertIsNone(r.read())
        self.assertGreater(r.backoff_until, clock.t)

    def test_not_active_reenables(self):
        clock = Clock()
        m = FakeModem({"AT+QGPS?": ["+QGPS: 1", "+QGPS: 0"], "AT+QGPS=1": "OK", "AT+QGPSLOC=2": ["+CME ERROR: 505", FIX]})
        r = reader(m, clock)
        self.assertIsNone(r.read())
        self.assertIsNotNone(r.read())
        self.assertIn("AT+QGPS=1", m.calls)


class Payloads(unittest.TestCase):
    def test_gps_with_cell(self):
        cell = parse_qeng_serving_cell(LTE)
        _, fix = parse_qgpsloc(FIX, NOW)
        p = build_gps_location(fix, cell)
        self.assertEqual(p["method"], "gps")
        self.assertEqual(p["cell"], {"radio": "lte", "mcc": 234, "mnc": 10, "lac": 12345, "cellId": 27440068})
        self.assertEqual(p["signalStrength"], -95)

    def test_gps_without_cell(self):
        _, fix = parse_qgpsloc(FIX, NOW)
        p = build_gps_location(fix, None)
        self.assertNotIn("cell", p)


if __name__ == "__main__":
    unittest.main()
