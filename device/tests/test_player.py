"""Regression tests for the player state machine and the playback log it writes.

Drives the real PlayerManager with a fake mpv (IPC socket) and a fake clock; see support.py.
Finding numbers refer to the device audit.
"""

import json
import os
import sys
import types
import unittest
from collections import Counter
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402
from support import BASE, FakeClock, MpvFactory, make_time_shim, reset_base_dir  # noqa: E402

import common  # noqa: E402
import player_manager as pm  # noqa: E402
from log_queue import PlaybackLogQueue  # noqa: E402

S = pm.PlayerState


def slot_loop(static_assets=None):
    """10 slots; each: ad (0-12s), fillers 12-30, 30-45, 45-60. Ad assets ad-0..ad-9."""
    static_assets = static_assets or {}
    slots = []
    for p in range(10):
        slots.append({
            "position": p,
            "staticImageAssetId": static_assets.get(p),
            "contents": [
                {"type": "ADVERTISEMENT", "assetId": f"ad-{p}", "startTimeMs": 0, "durationMs": 12000},
                {"type": "FILLER", "assetId": "weather", "startTimeMs": 12000, "durationMs": 18000},
                {"type": "FILLER", "assetId": "news", "startTimeMs": 30000, "durationMs": 15000},
                {"type": "FILLER", "assetId": "brand", "startTimeMs": 45000, "durationMs": 15000},
            ],
        })
    return slots


def write_manifest(slots=None, total_ms=600000, safety=None, loop_id="loop-A", checksum="c1", statics=True):
    cur = common.CURRENT_DIR
    (cur / "statics").mkdir(parents=True, exist_ok=True)
    (cur / "loop.mp4").write_bytes(b"loop")
    if statics:
        for i in range(10):
            (cur / "statics" / f"slot_{i:02d}.jpg").write_bytes(b"jpg")
    manifest = {"loopId": loop_id, "checksum": checksum, "totalDurationMs": total_ms, "slots": slots or []}
    for name in ("safety.mp4", "safety.jpg"):
        (cur / name).unlink(missing_ok=True)
    if safety:
        manifest["safetyVideo"] = safety
        name = "safety.jpg" if safety["mimeType"].startswith("image/") else "safety.mp4"
        (cur / name).write_bytes(b"s")
    common.atomic_write_json(cur / "manifest.json", manifest)


SAFETY_VIDEO = {"url": "http://x/s.mp4", "durationMs": 8000, "mimeType": "video/mp4", "checksum": "sha256:" + "a" * 64}


class PlayerTestBase(unittest.TestCase):
    trigger = "gpio"
    config_overrides: dict = {}

    def setUp(self):
        config = json.loads(json.dumps(support.CONFIG))
        for section, values in self.config_overrides.items():
            config.setdefault(section, {}).update(values)
        reset_base_dir(config)
        common.DEFAULT_STATIC_IMAGE_PATH.exists() or self.skipTest("default still missing from device/")
        self.clock = FakeClock()
        self.durations = {"loop.mp4": 600.0, "safety.mp4": 8.0}
        sock = str(common.RUNTIME_DIR / "mpv.sock")
        self.mpv = MpvFactory(sock, self.clock, self.durations)
        self.patches = [
            mock.patch.object(pm, "time", make_time_shim(self.clock)),
            mock.patch.object(pm, "MPV_SOCKET_PATH", sock),
            mock.patch.object(pm, "subprocess", types.SimpleNamespace(Popen=self.mpv.popen)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        self.mpv.stop_all()
        for p in reversed(self.patches):
            p.stop()

    def new_player(self, start=True):
        p = pm.PlayerManager()
        p.logger.setLevel(100)
        p.trigger = self.trigger
        p.reload_timeline()
        if start:
            p.start_initial_state(self.clock.t)
        return p

    def run_for(self, p, seconds, step=1.0):
        end = self.clock.t + seconds
        while self.clock.t < end - 1e-9:
            p.step()
            self.clock.sleep(step)

    def logs(self):
        q = PlaybackLogQueue(common.LOG_DIR)
        entries = []
        for seg in q.segments():
            entries.extend(common.read_jsonl(seg))
        entries.extend(common.read_jsonl(common.PLAYBACK_LOG_PATH))
        return entries

    def clear_logs(self):
        common.PLAYBACK_LOG_PATH.unlink(missing_ok=True)

    def plays(self, entries=None):
        return [e for e in (entries if entries is not None else self.logs()) if not e.get("event")]


class TestContractFields(PlayerTestBase):
    def test_every_entry_has_unique_event_id_and_loop_id(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        self.run_for(p, 70)
        p.on_door_sensor()
        self.run_for(p, 100)
        p.on_door_sensor()
        self.run_for(p, 10)
        entries = self.logs()
        self.assertGreater(len(entries), 5)
        ids = [e["eventId"] for e in entries]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(e["loopId"] == "loop-A" for e in entries))

    def test_entries_keep_the_loop_that_was_on_screen_across_a_reload(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 20)
        write_manifest(slots=slot_loop(), loop_id="loop-B", checksum="c2")
        common.write_player_command("reload", loopId="loop-B", commandId="r1")
        self.run_for(p, 30)
        p.on_door_sensor()
        self.run_for(p, 6)
        by_loop = Counter(e["loopId"] for e in self.plays())
        self.assertIn("loop-A", by_loop)
        self.assertIn("loop-B", by_loop)
        state = common.read_json(common.PLAYER_STATE_PATH)
        self.assertEqual(state["lastHandledCommandId"], "r1")
        self.assertTrue(state["lastHandledOk"])


class TestStillsAreNotAdverts(PlayerTestBase):
    """Finding 3."""

    def test_idle_stills_logged_as_static_image(self):
        write_manifest(slots=slot_loop(static_assets={1: "still-creative-1"}))
        common.slot_static_path(3).unlink()  # this slot falls back to the default still
        p = self.new_player()
        self.run_for(p, 241)
        entries = self.plays()
        self.assertEqual(len(entries), 4)
        for e in entries:
            self.assertEqual(e["type"], "STATIC_IMAGE")
            self.assertIsNone(e["contentType"])
            self.assertEqual(e["mode"], "idle")
            self.assertTrue(e["completedFull"])
            self.assertEqual(e["durationMs"], 60000)
        by_slot = {e["slotPosition"]: e["assetId"] for e in entries}
        self.assertEqual(by_slot, {0: None, 1: "still-creative-1", 2: None, 3: None})

    def test_real_static_with_missing_file_is_not_attributed(self):
        write_manifest(slots=slot_loop(static_assets={0: "still-creative-0"}))
        common.slot_static_path(0).unlink()
        p = self.new_player()
        self.run_for(p, 61)
        self.assertIsNone(self.plays()[0]["assetId"])

    def test_muted_stills_are_static_images(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 20)
        p.on_passenger_button()
        self.run_for(p, 50)
        stills = [e for e in self.plays() if e["mode"] == "silent"]
        self.assertTrue(stills)
        for e in stills:
            self.assertEqual(e["type"], "STATIC_IMAGE")
            self.assertIsNone(e["contentType"])
            self.assertIsNone(e["assetId"])
        self.assertEqual(stills[0]["durationMs"], 40000)  # muted at 20 s, slot ended at 60 s
        self.assertFalse(stills[0]["completedFull"])


class TestJourneyLogging(PlayerTestBase):
    def test_advert_at_position_zero_is_logged_on_a_fresh_journey(self):
        """Finding 4."""
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 61)
        plays = [e for e in self.plays() if e["mode"] == "journey"]
        self.assertEqual(plays[0]["assetId"], "ad-0")
        self.assertEqual(plays[0]["contentType"], "ADVERTISEMENT")
        self.assertEqual(plays[0]["durationMs"], 12000)
        self.assertTrue(plays[0]["completedFull"])
        self.assertEqual([e["assetId"] for e in plays], ["ad-0", "weather", "news", "brand"])

    def test_full_journey_counts_each_item_once_per_pass(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 8 + 25 * 60)
        p.on_door_sensor()
        self.run_for(p, 10)
        ads = [e for e in self.plays() if e["contentType"] == "ADVERTISEMENT" and e["completedFull"]]
        counts = Counter(e["assetId"] for e in ads)
        # 25 minutes = 2.5 passes: slots 0-4 three times, 5-9 twice.
        self.assertEqual(counts, Counter({**{f"ad-{i}": 3 for i in range(5)}, **{f"ad-{i}": 2 for i in range(5, 10)}}))

    def test_items_logged_when_they_end_with_measured_duration(self):
        """Finding 12: journey ends 5 s into the first advert."""
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 5)
        self.assertEqual([e for e in self.plays() if e["mode"] == "journey"], [])  # nothing logged at start
        p.on_door_sensor()
        self.run_for(p, 2)
        ad = [e for e in self.plays() if e["mode"] == "journey"]
        self.assertEqual(len(ad), 1)
        self.assertEqual((ad[0]["assetId"], ad[0]["durationMs"], ad[0]["completedFull"]), ("ad-0", 5000, False))

    def test_safety_logged_after_it_plays(self):
        """Finding 12: the safety message used to be logged as complete before it played."""
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        p.on_door_sensor()
        self.assertEqual(p.state, S.SAFETY)
        self.assertEqual([e for e in self.plays() if e["type"] == "SAFETY"], [])
        self.run_for(p, 12)
        safety = [e for e in self.plays() if e["type"] == "SAFETY"]
        self.assertEqual(len(safety), 1)
        self.assertEqual(safety[0]["durationMs"], 8000)
        self.assertTrue(safety[0]["completedFull"])
        self.assertIsNone(safety[0]["contentType"])
        self.assertEqual(p.state, S.JOURNEY)

    def test_safety_interrupted_is_not_complete(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 3)
        p.on_door_sensor()
        safety = [e for e in self.plays() if e["type"] == "SAFETY"]
        self.assertEqual((safety[0]["durationMs"], safety[0]["completedFull"]), (3000, False))
        self.assertEqual(p.state, S.IDLE)

    def test_safety_without_duration_waits_for_end_of_file(self):
        write_manifest(slots=slot_loop(), safety={"url": "x", "mimeType": "video/mp4"})
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 5)
        self.assertEqual(p.state, S.SAFETY)
        self.run_for(p, 5)
        self.assertEqual(p.state, S.JOURNEY)

    def test_still_image_safety(self):
        write_manifest(slots=slot_loop(), safety={"url": "x", "durationMs": 6000, "mimeType": "image/jpeg"})
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 6)
        self.assertEqual(p.state, S.SAFETY)
        self.run_for(p, 1)
        self.assertEqual(p.state, S.JOURNEY)
        safety = [e for e in self.plays() if e["type"] == "SAFETY"][0]
        self.assertEqual((safety["durationMs"], safety["completedFull"]), (6000, True))

    def test_rapid_mute_toggles_do_not_add_plays(self):
        """Finding 12: toggling mute used to add a 'complete' advert entry per toggle."""
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 2)
        for _ in range(3):  # presses within the same second
            p.on_passenger_button()
            p.on_passenger_button()
        for _ in range(2):  # one-second mutes
            p.on_passenger_button()
            self.run_for(p, 1)
            p.on_passenger_button()
            self.run_for(p, 1)
        self.run_for(p, 20)
        journey = [e for e in self.plays() if e["mode"] == "journey"]
        ad0 = [e for e in journey if e["assetId"] == "ad-0"]
        self.assertEqual(len(ad0), 1, journey)
        self.assertEqual(ad0[0]["durationMs"], 10000)  # 12 s scheduled, 2 s of it muted
        self.assertFalse(ad0[0]["completedFull"])
        stills = [e for e in self.plays() if e["mode"] == "silent"]
        self.assertEqual(len(stills), 2)
        self.assertTrue(all(e["durationMs"] == 1000 and not e["completedFull"] for e in stills))

    def test_unmute_resumes_without_a_new_full_play(self):
        """Finding 4 (resume half): unmuting mid-item must not log it as a fresh complete play."""
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 20)  # into 'weather' (12-30)
        p.on_passenger_button()
        self.run_for(p, 50)  # muted until 70 s: slot 1 ad (60-72) partly missed
        p.on_passenger_button()
        self.run_for(p, 15)
        journey = [e for e in self.plays() if e["mode"] == "journey"]
        ad1 = [e for e in journey if e["assetId"] == "ad-1"]
        self.assertEqual(len(ad1), 1)
        self.assertEqual((ad1[0]["durationMs"], ad1[0]["completedFull"]), (2000, False))
        weather = [e for e in journey if e["assetId"] == "weather"]
        self.assertEqual((weather[0]["durationMs"], weather[0]["completedFull"]), (8000, False))


class TestJourneyBookkeeping(PlayerTestBase):
    """Finding 13."""

    def events(self):
        return [e for e in self.logs() if e.get("event")]

    def test_door_during_wind_down_starts_next_journey(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 30)
        p.on_door_sensor()
        self.assertEqual(p.state, S.WIND_DOWN)
        self.run_for(p, 2)
        p.on_door_sensor()
        self.assertEqual(p.state, S.JOURNEY)
        self.run_for(p, 10)
        p.on_door_sensor()
        self.run_for(p, 10)
        names = [e["event"] for e in self.events()]
        self.assertEqual(names, ["JOURNEY_START", "JOURNEY_END", "JOURNEY_START", "JOURNEY_END"])
        journeys = {e["journeyId"] for e in self.events()}
        self.assertEqual(len(journeys), 2)

    def test_disable_mid_journey_ends_the_journey(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 30)
        common.write_player_command("set_disabled", disabled=True)
        self.run_for(p, 2)
        self.assertEqual(p.state, S.DISABLED)
        end = [e for e in self.events() if e["event"] == "JOURNEY_END"]
        self.assertEqual(len(end), 1)
        self.assertEqual(end[0]["endReason"], "disabled")
        common.write_player_command("set_disabled", disabled=False)
        self.run_for(p, 2)
        self.assertEqual(p.state, S.IDLE)

    def test_journey_end_duration_includes_safety(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 38)
        p.on_door_sensor()
        end = [e for e in self.events() if e["event"] == "JOURNEY_END"][0]
        self.assertEqual(end["durationMs"], 38000)

    def test_safety_phase_reported_distinctly(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        p.on_door_sensor()
        p.write_state(force=True)
        state = common.read_json(common.PLAYER_STATE_PATH)
        self.assertEqual((state["state"], state["mode"]), ("SAFETY", "safety"))
        self.run_for(p, 10)
        state = common.read_json(common.PLAYER_STATE_PATH)
        self.assertEqual((state["state"], state["mode"]), ("JOURNEY", "journey"))

    def test_shutdown_closes_journey_and_flushes(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 15)
        with mock.patch.object(p.queue, "flush", wraps=p.queue.flush) as flush:
            p.shutdown("shutdown")
            self.assertTrue(flush.called)
        end = [e for e in self.events() if e["event"] == "JOURNEY_END"]
        self.assertEqual(end[0]["endReason"], "shutdown")
        weather = [e for e in self.plays() if e["assetId"] == "weather"][0]
        self.assertEqual((weather["durationMs"], weather["completedFull"]), (3000, False))


class TestSlotlessLoop(PlayerTestBase):
    """Finding 20: a directly uploaded loop (manifest with no slots)."""

    def test_idle_shows_one_still_without_reloading_or_phantom_slots(self):
        self.durations["loop.mp4"] = 60.0
        write_manifest(slots=[], total_ms=60000, statics=False)
        p = self.new_player()
        loads = self.mpv.current.loadfile_count()
        self.run_for(p, 600)
        self.assertEqual(self.mpv.current.loadfile_count(), loads)
        p.on_door_sensor()  # closes the idle still
        stills = [e for e in self.plays() if e["mode"] == "idle"]
        self.assertEqual(len(stills), 1)
        self.assertEqual((stills[0]["type"], stills[0]["slotPosition"], stills[0]["assetId"]), ("STATIC_IMAGE", None, None))

    def test_journey_logs_one_play_per_pass(self):
        self.durations["loop.mp4"] = 60.0
        write_manifest(slots=[], total_ms=60000, statics=False)
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 300)
        p.on_door_sensor()
        plays = [e for e in self.plays() if e["mode"] == "journey"]
        self.assertEqual(len(plays), 5)
        self.assertTrue(all(e["type"] == "LOOP_VIDEO" and e["durationMs"] == 60000 and e["completedFull"] for e in plays))

    def test_slot_length_comes_from_the_manifest(self):
        slots = [{"position": i, "contents": [{"type": "ADVERTISEMENT", "assetId": f"ad-{i}", "startTimeMs": 0, "durationMs": 120000}]} for i in range(5)]
        write_manifest(slots=slots, total_ms=600000)
        p = self.new_player()
        self.run_for(p, 241)
        stills = self.plays()
        self.assertEqual([(e["slotPosition"], e["durationMs"]) for e in stills], [(0, 120000), (1, 120000)])
        p.on_door_sensor()
        self.run_for(p, 250)
        ads = [e for e in self.plays() if e["mode"] == "journey"]
        self.assertEqual([(e["assetId"], e["durationMs"]) for e in ads], [("ad-0", 120000), ("ad-1", 120000)])

    def test_fallback_loop_length_measured_from_mpv(self):
        self.durations["loop.mp4"] = 30.0
        common.CURRENT_DIR.mkdir(parents=True, exist_ok=True)
        (BASE / "fallback.mp4").write_bytes(b"fallback")
        self.assertTrue(common.copy_fallback_to_current(common.load_config()))
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 95)
        plays = [e for e in self.plays() if e["mode"] == "journey"]
        self.assertEqual([e["durationMs"] for e in plays], [30000, 30000, 30000])
        self.assertTrue(all(e["loopId"] == "fallback" for e in plays))


class TestAlwaysTrigger(PlayerTestBase):
    """Finding 1: playback without passenger detection."""

    trigger = "always"

    def test_cycle_is_safety_then_one_full_pass(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        self.assertEqual(p.state, S.SAFETY)
        self.run_for(p, 8 + 600 + 8 + 600 + 5)
        entries = self.logs()
        self.assertEqual([e for e in entries if e.get("event")], [])  # no JOURNEY events in this mode
        seq = [e["type"] for e in entries]
        self.assertEqual(seq.count("SAFETY"), 2)
        self.assertEqual(seq[0], "SAFETY")
        self.assertEqual(seq[41], "SAFETY")  # after 40 loop items
        self.assertTrue(all(e["mode"] == "continuous" for e in entries))
        self.assertEqual(entries[1]["assetId"], "ad-0")
        ads = Counter(e["assetId"] for e in entries if e["contentType"] == "ADVERTISEMENT" and e["completedFull"])
        self.assertEqual(ads, Counter({f"ad-{i}": 2 for i in range(10)}))
        self.assertTrue(all(e["journeyId"] is None for e in entries))

    def test_safety_every_nth_cycle(self):
        self.config_overrides = {}
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        p.config.raw.setdefault("playback", {})["alwaysSafetyEveryCycles"] = 2
        self.run_for(p, 8 + 600 * 2 + 8 + 30)
        seq = [e["type"] for e in self.logs()]
        self.assertEqual(seq.count("SAFETY"), 2)
        self.assertEqual(seq.index("SAFETY", 1), 81)  # two passes of 40 items, then the safety message

    def test_mute_and_override_work(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        self.run_for(p, 20)
        p.on_passenger_button()
        self.assertEqual(p.state, S.SILENT)
        self.run_for(p, 10)
        p.on_passenger_button()
        self.assertEqual(p.state, S.JOURNEY)
        p.on_door_sensor()  # no door input in this mode
        self.assertEqual(p.state, S.JOURNEY)
        p.on_driver_override()  # restarts the cycle with the safety message
        self.assertEqual(p.state, S.SAFETY)
        silent = [e for e in self.plays() if e["mode"] == "silent"]
        self.assertEqual(len(silent), 1)

    def test_disable_and_enable_restart_the_cycle(self):
        write_manifest(slots=slot_loop(), safety=SAFETY_VIDEO)
        p = self.new_player()
        self.run_for(p, 30)
        common.write_player_command("set_disabled", disabled=True)
        self.run_for(p, 2)
        self.assertEqual(p.state, S.DISABLED)
        common.write_player_command("set_disabled", disabled=False)
        self.run_for(p, 1)
        self.assertEqual(p.state, S.SAFETY)


class TestTriggerSelection(PlayerTestBase):
    def make(self, trigger, tty=False, gpio=False):
        cfg = common.load_config()
        cfg.raw.setdefault("playback", {})["trigger"] = trigger
        p = pm.PlayerManager(config=cfg)
        p.logger.setLevel(100)
        fake_gpio = types.SimpleNamespace(
            BCM=1, IN=1, PUD_UP=1, FALLING=1, setmode=lambda *a: None,
            setup=mock.Mock(), add_event_detect=mock.Mock(),
        )
        modules = {"RPi": types.SimpleNamespace(GPIO=fake_gpio), "RPi.GPIO": fake_gpio} if gpio else {"RPi": None, "RPi.GPIO": None}
        stdin = types.SimpleNamespace(isatty=lambda: tty)
        with mock.patch.dict(sys.modules, modules), mock.patch.object(pm.sys, "stdin", stdin), \
                mock.patch.object(pm.threading, "Thread") as thread:
            p.start_input_listeners()
        return p, fake_gpio, thread

    def test_auto_on_x86_under_systemd_is_always(self):
        p, _, thread = self.make("auto")
        self.assertEqual(p.trigger, "always")
        thread.assert_not_called()

    def test_missing_key_defaults_to_auto(self):
        self.assertEqual(common.DeviceConfig({"device": {}}).playback_trigger, "auto")
        self.assertEqual(common.DeviceConfig({"playback": {"trigger": "bogus"}}).playback_trigger, "auto")

    def test_auto_with_terminal_is_keyboard(self):
        p, _, thread = self.make("auto", tty=True)
        self.assertEqual(p.trigger, "keyboard")
        thread.assert_called_once()

    def test_auto_with_gpio(self):
        p, gpio, _ = self.make("auto", gpio=True)
        self.assertEqual(p.trigger, "gpio")
        pins = [c.args[0] for c in gpio.add_event_detect.call_args_list]
        self.assertEqual(sorted(pins), sorted([pm.PASSENGER_BUTTON_PIN, pm.DOOR_SENSOR_PIN, pm.DRIVER_OVERRIDE_PIN]))

    def test_explicit_gpio_without_gpio_still_plays(self):
        p, _, _ = self.make("gpio")
        self.assertEqual(p.trigger, "always")

    def test_always_keeps_mute_and_override_inputs(self):
        p, gpio, _ = self.make("always", gpio=True)
        self.assertEqual(p.trigger, "always")
        pins = sorted(c.args[0] for c in gpio.add_event_detect.call_args_list)
        self.assertEqual(pins, sorted([pm.PASSENGER_BUTTON_PIN, pm.DRIVER_OVERRIDE_PIN]))

    def test_trigger_is_in_state_file(self):
        p, _, _ = self.make("always")
        p.write_state(force=True)
        self.assertEqual(common.read_json(common.PLAYER_STATE_PATH)["trigger"], "always")


class TestMpvFailures(PlayerTestBase):
    """Finding 14: repeated mpv failure must do something real and bounded."""

    def test_crash_mid_advert_resumes_same_entry(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.on_door_sensor()
        self.run_for(p, 4)
        self.mpv.current.die()
        self.run_for(p, 20)
        ad0 = [e for e in self.plays() if e["assetId"] == "ad-0"]
        self.assertEqual(len(ad0), 1)
        self.assertFalse(ad0[0]["completedFull"])
        self.assertLess(ad0[0]["durationMs"], 12000)
        self.assertEqual(p.state, S.JOURNEY)
        self.assertIsNotNone(p.process)

    def test_backoff_output_switch_and_bounded_exit(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        p.output_candidates = [["--vo=gpu", "--gpu-context=drm"], []]
        starts = []
        with self.assertRaises(pm.PlayerFatal):
            for _ in range(400):
                if p.process is not None:
                    starts.append(self.clock.t)
                    p.process.die()
                p.step()
                self.clock.sleep(1)
        self.assertEqual(p.output_index, 1)
        gaps = [b - a for a, b in zip(starts, starts[1:])]
        self.assertGreater(max(gaps), 30)  # backed off instead of hammering
        self.assertEqual(p.status_name(), "error")

    def test_failures_after_long_runs_do_not_accumulate(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        for _ in range(12):
            self.run_for(p, 120)
            p.process.die()
            self.run_for(p, 3)
        self.assertIsNotNone(p.process)

    def test_mpv_missing_is_a_failure_not_a_crash(self):
        write_manifest(slots=slot_loop())
        self.mpv.fail_to_start = True
        p = self.new_player()
        self.assertTrue(p.mpv_down)
        self.assertEqual(p.status_name(), "error")
        self.mpv.fail_to_start = False
        self.run_for(p, 5)
        self.assertFalse(p.mpv_down)


class TestSmallFixes(PlayerTestBase):
    """Finding 24 (player half)."""

    def test_redundant_set_disabled_does_not_reload(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        common.write_player_command("set_disabled", disabled=True)
        self.run_for(p, 2)
        before = self.mpv.current.loadfile_count()
        for _ in range(3):
            common.write_player_command("set_disabled", disabled=True)
            self.run_for(p, 2)
        self.assertEqual(self.mpv.current.loadfile_count(), before)
        loads_idle = self.mpv.current.loadfile_count()
        common.write_player_command("set_disabled", disabled=False)
        self.run_for(p, 2)
        common.write_player_command("set_disabled", disabled=False)
        self.run_for(p, 2)
        self.assertEqual(self.mpv.current.loadfile_count(), loads_idle + 1)

    def test_state_file_not_rewritten_every_second(self):
        write_manifest(slots=slot_loop())
        p = self.new_player()
        with mock.patch.object(pm, "atomic_write_json", wraps=pm.atomic_write_json) as write, \
                mock.patch.object(pm, "read_json_dict", wraps=pm.read_json_dict) as read_manifest:
            self.run_for(p, 60)
        self.assertLessEqual(write.call_count, 8)
        self.assertTrue(all(c.kwargs.get("durable") is False for c in write.call_args_list))
        self.assertEqual(read_manifest.call_count, 0)

    def test_missing_default_still_does_not_crash(self):
        write_manifest(slots=slot_loop(), statics=False)
        with mock.patch.object(pm, "DEFAULT_STATIC_IMAGE_PATH", BASE / "nope.jpg"):
            p = self.new_player()
            self.run_for(p, 5)
        self.assertEqual(self.mpv.current.path, pm.BLACK_FRAME_SOURCE)


class TestWatchdog(PlayerTestBase):
    """Finding 2: READY=1 once running, WATCHDOG=1 only after iterations that made progress."""

    def test_run_notifies_ready_and_pings_only_on_progress(self):
        write_manifest(slots=slot_loop())
        p = self.new_player(start=False)
        sent = []
        sleeps = [0]
        real_step = p.step

        def flaky_step():
            if 3 <= sleeps[0] < 6:
                raise RuntimeError("stuck")
            real_step()

        def sleep(seconds):
            self.clock.sleep(seconds)
            sleeps[0] += 1
            if sleeps[0] >= 10:
                p.stopping = True

        p.step = flaky_step
        shim = make_time_shim(self.clock)
        shim.sleep = staticmethod(sleep)
        with mock.patch.object(pm, "notify", side_effect=lambda m: sent.append(m)), \
                mock.patch.object(pm, "time", shim), mock.patch.object(pm.signal, "signal"):
            p.run()
        self.assertEqual(sent[0], "READY=1")
        self.assertEqual(sent.count("WATCHDOG=1"), 7)  # 10 iterations, 3 of them failed
        self.assertEqual(sent[-1], "STOPPING=1")


class TestOutputOptions(unittest.TestCase):
    """Finding 17 (mpv half): connector and mode are configurable, auto lets mpv choose."""

    def test_auto_without_desktop_prefers_drm_without_hard_coded_connector(self):
        options = pm.mpv_output_candidates({"videoOutput": "auto"}, environ={}, x11_socket_dir=Path("/nonexistent"))
        self.assertEqual(options[0], ["--vo=gpu", "--gpu-context=drm"])
        self.assertEqual(options[1], [])

    def test_desktop_session_lets_mpv_choose_first(self):
        tmp = BASE / "x11"
        tmp.mkdir(parents=True, exist_ok=True)
        (tmp / "X0").write_text("")
        options = pm.mpv_output_candidates({"videoOutput": "auto"}, environ={"DISPLAY": ":0"}, x11_socket_dir=tmp)
        self.assertEqual(options[0], [])

    def test_explicit_connector_and_mode(self):
        options = pm.mpv_output_candidates({"videoOutput": "drm", "drmConnector": "eDP-1", "drmMode": "1920x1080"}, environ={})
        self.assertEqual(options, [["--vo=gpu", "--gpu-context=drm", "--drm-connector=eDP-1", "--drm-mode=1920x1080"]])

    def test_keepaspect_default_and_no_geometry(self):
        reset_base_dir()
        p = pm.PlayerManager()
        p.logger.setLevel(100)
        line = p.mpv_command_line("x.mp4", loop_forever=False)
        self.assertIn("--keepaspect=yes", line)
        self.assertFalse(any(a.startswith("--geometry") or a.startswith("--drm-connector=HDMI") for a in line))

    def test_detect_connectors(self):
        root = BASE / "drm"
        for name, status, modes in [("card0-HDMI-A-1", "disconnected", ""), ("card0-eDP-1", "connected", "1920x1080\n1280x720\n")]:
            (root / name).mkdir(parents=True, exist_ok=True)
            (root / name / "status").write_text(status + "\n")
            (root / name / "modes").write_text(modes)
        self.assertEqual(pm.detect_drm_connectors(root), [{"name": "eDP-1", "card": "card0", "mode": "1920x1080"}])



class TestSdNotify(unittest.TestCase):
    """Finding 2: the notify protocol itself."""

    def test_sends_datagrams_and_is_a_no_op_without_socket(self):
        import socket
        import sd_notify
        path = str(BASE / "notify.sock")
        if os.path.exists(path):
            os.unlink(path)
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
            server.bind(path)
            server.settimeout(2)
            self.assertTrue(sd_notify.notify("READY=1", {"NOTIFY_SOCKET": path}))
            self.assertEqual(server.recv(100), b"READY=1")
        self.assertFalse(sd_notify.notify("WATCHDOG=1", {}))
        self.assertFalse(sd_notify.notify("WATCHDOG=1", {"NOTIFY_SOCKET": path}))  # nobody listening: no exception

    def test_abstract_namespace(self):
        import socket
        import sd_notify
        name = "orison-test-" + os.urandom(4).hex()
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
            server.bind("\0" + name)
            server.settimeout(2)
            self.assertTrue(sd_notify.notify("WATCHDOG=1", {"NOTIFY_SOCKET": "@" + name}))
            self.assertEqual(server.recv(100), b"WATCHDOG=1")

    def test_unit_file_matches(self):
        unit = (support.DEVICE_DIR / "systemd" / "orison-player.service").read_text()
        self.assertIn("Type=notify", unit)
        self.assertIn("NotifyAccess=main", unit)
        self.assertIn("WatchdogSec=", unit)


if __name__ == "__main__":
    unittest.main()
