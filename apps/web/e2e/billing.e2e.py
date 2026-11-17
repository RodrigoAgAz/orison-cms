#!/usr/bin/env python3
"""The billing path, end to end, with the real components.

    cd /home/user/orison-cms && set -a && . ./.env && set +a && python3 apps/web/e2e/billing.e2e.py

Needs a running dev server (BASE_URL, default http://localhost:3000), DATABASE_URL (to read what
the server stored and to remove the test cabs, which have no delete API), psql, ffmpeg, node
(tsx, from the repo), and python3 with requests and psutil (as on a cab).

What it does, all through the real APIs and the real firmware in device/:
  1. uploads distinguishable test adverts (10/15/20/30 s), fillers (one held, one cut), a still
     image and a safety message; builds two ten-slot loops; publishes loop A to test group 1 and
     loop B to test group 2; one test cab sits in group 1.
  2. runs the real SyncAgent (downloads, verifies, activates; the real PlayerManager confirms),
     the real PlayerManager on the fake mpv and fake clock from device/tests, and the real
     HealthMonitor (heartbeats and playback-log upload) through a scripted session: idle stills,
     journeys of different lengths (one ending mid-advert, one shorter than the safety message,
     one longer than the loop so it wraps), a mute and unmute, a loop change between sessions
     (the cab moves to group 2), an unchanged republish (no sync at all) and a republish that
     changes only the manifest (no video downloaded), uploads with one connection failure, one
     lost response and one deliberate re-send of a batch; then a run in `always` trigger mode over
     more than one full pass with the safety message.
  3. runs the same session with firmware 1.0.0 (its code taken from git history, in a separate
     process) for a second test cab, uploading with 1.0.0's own uploader.
  4. computes the plays independently from the scripted session and the manifests, and checks
     them against the rows the server stored, the desktop analytics (getAnalyticsData, the
     function the analytics page renders) and the CSV export (/api/analytics/export).
It removes everything it created (also after a failure). The safety message setting is global:
if none is configured, one is configured for the minute or two the cab session runs and the
previous setting is restored right after (the cab keeps its downloaded copy for the `always` run).

Exit code 0 when every check passes. KEEP_WORK=1 keeps the temp directory for inspection.
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
import urllib.parse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
DEVICE = REPO / "device"
BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000").rstrip("/")
API = BASE_URL + "/api"
DEVICE_TOKEN = os.environ.get("DEVICE_SHARED_TOKEN", "local-device-token")
EMAIL = os.environ.get("E2E_EMAIL", "admin@orisonscreens.com")
PASSWORD = os.environ.get("E2E_PASSWORD", "ChangeMe123!")
DATABASE_URL = (os.environ.get("DATABASE_URL") or "").split("?")[0]
OLD_FIRMWARE_COMMIT = "8339913"  # last commit with device firmware 1.0.0 (1562eb4 is 1.1.0)

# ------------------------------------------------------------------------------------------------
# The scripted session (fake seconds). Both the real player and the reference model follow it.
# ("idle", s) run s seconds; ("door",) door sensor; ("mute",) passenger button; ("sync", why)
# a sync cycle; ("heartbeat",); ("upload", how); ("group", n) move the cab to test group n;
# ("republish", what) republish loop B.
# ------------------------------------------------------------------------------------------------

SESSION_1 = [  # on loop A
    ("idle", 150),
    ("door",), ("idle", 72), ("door",),                 # J1: ends 66 s into the loop, mid-advert
    ("idle", 205),
    ("door",), ("idle", 136), ("mute",), ("idle", 60), ("mute",), ("idle", 510), ("door",),
                                                        # J2: mute 130-190 s, wraps at 600 s
    ("idle", 95),
    ("door",), ("idle", 3), ("door",),                  # J3: shorter than the safety message
    ("idle", 30),
]
SESSION_2 = [  # on loop B
    ("idle", 65),
    ("door",), ("idle", 206), ("door",),                # J4
    ("idle", 45),
]
SESSION_3 = [  # on loop B after a manifest-only republish
    ("idle", 20),
    ("door",), ("idle", 256), ("door",),                # J5
    ("idle", 15),
]
ALWAYS_SECONDS_AFTER_FIRST_PASS = 300  # always mode: safety, a full pass, safety, 300 s more

checks_failed = 0


def check(condition: bool, message: str, detail: object = None) -> bool:
    global checks_failed
    if condition:
        print(f"  ok   {message}")
    else:
        checks_failed += 1
        print(f"  FAIL {message}")
        if detail is not None:
            print(f"       {detail}")
    return condition


def step(title: str) -> None:
    print(f"\n== {title}")


# ------------------------------------------------------------------------------------------------
# Server helpers
# ------------------------------------------------------------------------------------------------


class Cms:
    def __init__(self) -> None:
        import requests

        self.requests = requests
        self.http = requests.Session()
        r = self.http.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30)
        r.raise_for_status()

    def call(self, method: str, path: str, body=None, *, raw: bytes | None = None, ok=(200, 201, 202), timeout=120):
        for attempt in range(3):
            if raw is not None:
                r = self.http.request(method, API + path, data=raw, headers={"content-type": "application/octet-stream"}, timeout=timeout)
            else:
                r = self.http.request(method, API + path, json=body, timeout=timeout)
            # The dev server can answer 500 while it compiles a route on first use.
            if r.status_code >= 500 and attempt < 2:
                time.sleep(3)
                continue
            break
        try:
            data = r.json()
        except ValueError:
            data = {"raw": r.text[:300]}
        if ok and r.status_code not in ok:
            raise RuntimeError(f"{method} {path}: HTTP {r.status_code} {str(data)[:400]}")
        return r.status_code, data

    def upload_asset(self, path: Path, category: str, metadata: dict) -> str:
        """Desktop upload in pieces (POST /api/uploads, PUT .../pieces/<n>, POST .../complete)."""
        import hashlib

        data = path.read_bytes()
        _, session = self.call("POST", "/uploads", {"kind": "asset", "fileName": path.name, "size": len(data),
                                                    "fingerprint": hashlib.sha256(data).hexdigest(), "category": category,
                                                    "metadata": metadata})
        size = session["pieceBytes"]
        for index in range(session["pieceCount"]):
            if index in session.get("received", []):
                continue
            piece = data[index * size:(index + 1) * size]
            r = self.http.put(f"{API}/uploads/{session['uploadId']}/pieces/{index}", data=piece, timeout=120,
                              headers={"content-type": "application/octet-stream", "x-piece-sha256": hashlib.sha256(piece).hexdigest()})
            if not r.ok:
                raise RuntimeError(f"piece {index} of {path.name}: HTTP {r.status_code} {r.text[:200]}")
        _, result = self.call("POST", f"/uploads/{session['uploadId']}/complete")
        return result["assetId"]

    def device_get(self, path: str, serial: str):
        r = self.requests.get(API + path, headers={"Authorization": f"Bearer {DEVICE_TOKEN}", "X-Device-Serial": serial}, timeout=30)
        return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text)


def psql(sql: str) -> str:
    result = subprocess.run(["psql", DATABASE_URL, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"psql failed: {result.stderr.strip()}")
    return result.stdout.strip()


def psql_json(sql: str):
    out = psql(f"SELECT coalesce(json_agg(t), '[]'::json) FROM ({sql}) t")
    return json.loads(out or "[]")


def analytics_snapshot() -> dict:
    """getAnalyticsData(): exactly what the desktop analytics page renders."""
    code = (
        "import('./src/lib/fleet-data.ts').then(async (m) => {"
        " const f = m.getAnalyticsData ?? m.default.getAnalyticsData;"
        " const d = await f();"
        " process.stdout.write(JSON.stringify(d)); process.exit(0); })"
        ".catch((e) => { console.error(e); process.exit(1); });"
    )
    result = subprocess.run(["node", "--import", "tsx", "-e", code], cwd=REPO / "apps/web", capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        raise RuntimeError(f"getAnalyticsData failed: {result.stderr[-800:]}")
    data = json.loads(result.stdout)
    if data.get("error"):
        raise RuntimeError(f"getAnalyticsData error: {data['error']}")
    return data


def other_rows_marker(device_ids: list[str]) -> str:
    """Rows written by anyone else (to know whether fleet-wide totals can be compared exactly)."""
    ids = ",".join(f"'{i}'" for i in device_ids) or "''"
    return psql(f'SELECT count(*) || \':\' || coalesce(max("createdAt")::text, \'\') FROM "PlaybackLog" WHERE "deviceId" NOT IN ({ids})')


# ------------------------------------------------------------------------------------------------
# Media
# ------------------------------------------------------------------------------------------------

# key: (category, file seconds, colour, tone Hz). Adverts are distinguishable by colour and tone.
MEDIA = {
    "AD1": ("ADVERTISEMENT", 10, "0xc0392b", 440),
    "AD2": ("ADVERTISEMENT", 15, "0x2980b9", 523),
    "AD3": ("ADVERTISEMENT", 20, "0x27ae60", 587),
    "AD4": ("ADVERTISEMENT", 30, "0x8e44ad", 659),
    "FL1": ("FILLER_BRANDED", 18, "0x16a085", 0),   # given 20 s: held on its last frame
    "FL2": ("FILLER_OTHER", 25, "0xd35400", 330),
    "FL3": ("FILLER_OTHER", 30, "0x7f8c8d", 349),
    "FL4": ("FILLER_BRANDED", 40, "0x2c3e50", 392),
    "FL5": ("FILLER_OTHER", 45, "0xf39c12", 415),
    "FL6": ("FILLER_OTHER", 55, "0x34495e", 466),   # given 50 s: cut
    "STILL": ("STATIC_CREATIVE", None, "0xe84393", 0),
    "SAFETY": ("SAFETY_MESSAGE", 6, "0xffffff", 880),
}

# Slot recipes (asset, type, ms): every slot is exactly one minute.
RECIPES = [
    [("AD1", "A", 10000), ("FL6", "F", 50000)],
    [("AD2", "A", 15000), ("FL5", "F", 45000)],
    [("AD3", "A", 20000), ("FL4", "F", 40000)],
    [("AD4", "A", 30000), ("FL3", "F", 30000)],
    [("AD1", "A", 10000), ("FL3", "F", 30000), ("FL1", "F", 20000)],
    [("AD2", "A", 15000), ("FL2", "F", 25000), ("FL1", "F", 20000)],
    [("AD3", "A", 20000), ("FL4", "F", 40000)],
    [("AD4", "A", 30000), ("FL3", "F", 30000)],
    [("AD1", "A", 10000), ("FL6", "F", 50000)],
    [("AD2", "A", 15000), ("FL5", "F", 45000)],
]
LOOP_A = {"recipes": RECIPES, "still_slots": {2}}
LOOP_B = {"recipes": [RECIPES[(p + 3) % 10] for p in range(10)], "still_slots": {7}}
LOOP_B_REPUBLISH_STILL_SLOT = 4  # the manifest-only change: a still image for slot 4


def make_media(directory: Path, prefix: str) -> dict[str, Path]:
    files = {}
    for key, (category, seconds, colour, tone) in MEDIA.items():
        if category == "STATIC_CREATIVE":
            path = directory / f"{prefix}-{key}.png"
            args = ["-f", "lavfi", "-i", f"color=c={colour}:s=640x400", "-frames:v", "1", str(path)]
        else:
            path = directory / f"{prefix}-{key}.mp4"
            audio = ["-f", "lavfi", "-i", f"sine=frequency={tone}:sample_rate=48000"] if tone else []
            args = ["-f", "lavfi", "-i", f"color=c={colour}:s=320x200:r=30", *audio, "-t", str(seconds),
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
            args += (["-c:a", "aac", "-ac", "2"] if tone else []) + [str(path)]
        subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)
        files[key] = path
    return files


# ------------------------------------------------------------------------------------------------
# Reference model: the plays a correct cab must log, from the session and the manifest alone.
# Rules (DEVICE_CONTRACT_V2 and device/README.md): every item is logged once when it leaves the
# screen, with the time it was really visible; complete = within 500 ms of its scheduled length;
# glimpses under 1 s that are not complete are not logged. Stills: between journeys one per slot
# period from the start of the idle time; while muted one per slot period of the loop clock.
# Journeys: safety message, then the loop from its start; after a journey 5 s of the default
# still (not logged); a journey ended during the safety message goes straight back to idle.
# ------------------------------------------------------------------------------------------------


def safety_ticks(seconds: float) -> int:
    """Whole seconds (player ticks) until the loop replaces the safety message: the player moves
    on once mpv is within 250 ms of the end of the file (firmware 1.0.0 did the same)."""
    return math.ceil(seconds - 0.25 - 1e-9)


class Model:
    WIND_DOWN = 5.0

    def __init__(self, epoch0: float, serial: str) -> None:
        self.epoch0 = epoch0
        self.serial = serial
        self.entries: list[dict] = []
        self.t = 0.0
        self.manifest: dict | None = None
        self.safety_s: float | None = None
        self.state = "IDLE"
        self.idle_origin = 0.0
        self.journey_start = None
        self.safety_start = None
        self.loop_start = None
        self.mutes: list[list[float]] = []  # [start, end or None] within the current journey

    # -- manifest facts
    def items(self):
        out = []
        for slot in self.manifest["slots"]:
            for c in slot["contents"]:
                out.append({"start": c["absoluteStartMs"] / 1000.0, "dur": c["durationMs"] / 1000.0, "type": c["type"],
                            "assetId": c["assetId"], "slot": slot["position"]})
        return sorted(out, key=lambda i: i["start"])

    def total(self):
        return self.manifest["totalDurationMs"] / 1000.0

    def slot_s(self):
        return (self.manifest.get("slotDurationMs") or 60000) / 1000.0

    def still_asset(self, slot):
        return self.manifest["slots"][slot].get("staticImageAssetId")

    def add(self, *, start, dur_s, scheduled_s, type_, content_type, asset, slot, mode, state, event=None, complete=None, journey=None):
        dur_ms = int(round(dur_s * 1000))
        if complete is None:
            complete = scheduled_s is None or dur_ms >= scheduled_s * 1000 - 500
        if event is None and dur_ms < 1000 and not complete:
            return
        self.entries.append({
            "playedAt": self.epoch0 + start, "durationMs": dur_ms, "completedFull": bool(complete), "type": type_,
            "contentType": content_type, "assetId": asset, "slotPosition": slot, "mode": mode, "state": state,
            "event": event, "loopId": self.manifest["loopId"] if self.manifest else None, "journey": journey,
        })

    # -- stills
    def stills(self, origin, start, end, mode, state):
        period = self.slot_s()
        count = len(self.manifest["slots"])
        k = int(math.floor((start - origin) / period + 1e-9))
        while True:
            p_start = origin + k * period
            if p_start >= end - 1e-9:
                break
            a, b = max(p_start, start), min(p_start + period, end)
            if b > a:
                self.add(start=a, dur_s=b - a, scheduled_s=period, type_="STATIC_IMAGE", content_type=None,
                         asset=self.still_asset(k % count), slot=k % count, mode=mode, state=state)
            k += 1

    # -- loop video items visible in [L, end) minus mutes
    def video(self, L, end, mode, journey):
        T = self.total()
        visible = []
        cursor = L
        for m0, m1 in self.mutes:
            visible.append((cursor, m0))
            cursor = m1
        visible.append((cursor, end))
        items = self.items()
        p = 0
        while L + p * T < end:
            for it in items:
                a, b = L + p * T + it["start"], L + p * T + it["start"] + it["dur"]
                if a >= end:
                    break
                seen = sum(max(0.0, min(b, v1) - max(a, v0)) for v0, v1 in visible)
                if seen <= 0:
                    continue
                first = min(max(a, v0) for v0, v1 in visible if min(b, v1) > max(a, v0))
                self.add(start=first, dur_s=seen, scheduled_s=it["dur"], type_=it["type"], content_type=it["type"],
                         asset=it["assetId"], slot=it["slot"], mode=mode, state="JOURNEY", journey=journey)
            p += 1

    def silent_stills(self, journey):
        L = self.loop_start
        for m0, m1 in self.mutes:
            self.stills(L, m0, m1, "silent", "SILENT")
        _ = journey

    # -- session actions
    def start(self, manifest, safety_s):
        self.manifest, self.safety_s = manifest, safety_s
        self.state, self.idle_origin = "IDLE", self.t

    def reload(self, manifest, safety_s):
        """Content activated while idle: the idle still shown is closed, stills restart."""
        assert self.state == "IDLE", self.state
        self.stills(self.idle_origin, self.idle_origin, self.t, "idle", "IDLE")
        self.manifest, self.safety_s = manifest, safety_s
        self.idle_origin = self.t

    def idle(self, seconds):
        self.t += seconds
        if self.state == "WIND_DOWN" and self.t - self.wd_start >= self.WIND_DOWN:
            self.state = "IDLE"
            self.idle_origin = self.wd_start + self.WIND_DOWN
        if self.state == "SAFETY" and self.safety_s is not None and self.t >= self.safety_start + self.safety_s:
            self.state = "JOURNEY"
            self.loop_start = self.safety_start + safety_ticks(self.safety_s)

    def door(self):
        if self.state in ("IDLE", "WIND_DOWN"):
            if self.state == "IDLE":
                self.stills(self.idle_origin, self.idle_origin, self.t, "idle", "IDLE")
            self.journey_start = self.t
            self.mutes = []
            self.add(start=self.t, dur_s=0, scheduled_s=None, type_=None, content_type=None, asset=None, slot=None,
                     mode="journey", state=self.state, event="JOURNEY_START", complete=True, journey="J")
            if self.safety_s:
                self.state, self.safety_start = "SAFETY", self.t
            else:
                self.state, self.loop_start = "JOURNEY", self.t
            return
        end = self.t
        state_at_end = self.state
        if self.state == "SAFETY":
            self.add(start=self.safety_start, dur_s=end - self.safety_start, scheduled_s=self.safety_s, type_="SAFETY",
                     content_type=None, asset=None, slot=None, mode="journey", state="SAFETY", journey="J")
        else:
            if self.safety_s:
                self.add(start=self.safety_start, dur_s=min(self.safety_s, safety_ticks(self.safety_s)), scheduled_s=self.safety_s, type_="SAFETY",
                         content_type=None, asset=None, slot=None, mode="journey", state="SAFETY", journey="J")
            if self.mutes and self.mutes[-1][1] is None:
                self.mutes[-1][1] = end
            self.video(self.loop_start, end, "journey", "J")
            self.silent_stills("J")
        self.add(start=self.journey_start, dur_s=end - self.journey_start, scheduled_s=None, type_=None, content_type=None,
                 asset=None, slot=None, mode="journey", state=state_at_end, event="JOURNEY_END", complete=True, journey="J")
        if state_at_end == "SAFETY":
            self.state, self.idle_origin = "IDLE", end
        else:
            self.state, self.wd_start = "WIND_DOWN", end

    def mute(self):
        if self.mutes and self.mutes[-1][1] is None:
            self.mutes[-1][1] = self.t
        else:
            self.mutes.append([self.t, None])

    def shutdown(self):
        if self.state == "IDLE":
            self.stills(self.idle_origin, self.idle_origin, self.t, "idle", "IDLE")
        self.state = "OFF"

    # -- always mode: safety, one full pass, repeat (no journeys)
    def always(self, start, run_s):
        T = self.total()
        t = start
        end = start + run_s
        items = self.items()
        last_end = max(i["start"] + i["dur"] for i in items)
        while t < end:
            s = self.safety_s
            shown = min(s, safety_ticks(s))
            self.add(start=t, dur_s=min(shown, end - t), scheduled_s=s, type_="SAFETY", content_type=None, asset=None, slot=None,
                     mode="continuous", state="SAFETY")
            if t + shown >= end:
                break
            L = t + safety_ticks(s)
            self.mutes = []
            self.video(L, min(end, L + last_end), "continuous", None)
            t = L + math.ceil(last_end - 1e-9) if L + last_end < end else end
        _ = T


# ------------------------------------------------------------------------------------------------
# Firmware 1.0.0 runner (separate process: its modules share names with the current ones)
# ------------------------------------------------------------------------------------------------


def old_firmware_runner(args: list[str]) -> None:
    """argv: old_dir base_dir content_dir session_json epoch0 serial api"""
    old_dir, base_dir, content_dir, session_json, epoch0, serial, api = args
    os.environ["ORISON_BASE_DIR"] = base_dir
    sys.path.insert(0, str(DEVICE / "tests"))
    import support  # noqa: F401  (fake mpv and clock; imports the current common, dropped below)

    for name in ("common",):
        sys.modules.pop(name, None)
    sys.path.insert(0, old_dir)
    import common as old_common  # firmware 1.0.0
    import player_manager as old_pm
    import health_monitor as old_hm

    assert Path(old_common.__file__).parent == Path(old_dir), old_common.__file__
    base = Path(base_dir)
    (base / "config.json").write_text(json.dumps({
        "device": {"serialNumber": serial, "apiBaseUrl": api, "apiToken": DEVICE_TOKEN, "cdnBaseUrl": ""},
        "sync": {"checkIntervalSeconds": 1800}, "playback": {}, "health": {"heartbeatIntervalSeconds": 300}}))
    old_common.ensure_directories()
    shutil.rmtree(old_common.CURRENT_DIR, ignore_errors=True)
    shutil.copytree(content_dir, old_common.CURRENT_DIR)
    (old_common.CURRENT_DIR / "safety.json").unlink(missing_ok=True)  # 1.2.0's file; 1.0.0 reads the manifest's copy
    manifest = json.loads((old_common.CURRENT_DIR / "manifest.json").read_text())

    support.FakeMpv.send_events = False  # 1.0.0 reads one recv() as one JSON reply
    clock = support.FakeClock()
    clock.t = 0.0
    e0 = float(epoch0)
    clock.time = lambda: e0 + clock.t  # type: ignore[method-assign]

    class FakeDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(e0 + clock.t, tz or timezone.utc)

    sock = str(base / "mpv.sock")
    safety = manifest.get("safetyVideo") or {}
    mpv = support.MpvFactory(sock, clock, {"loop.mp4": manifest["totalDurationMs"] / 1000.0,
                                           "safety.mp4": (safety.get("durationMs") or 0) / 1000.0 or None})
    patches = [
        mock.patch.object(old_pm, "time", support.make_time_shim(clock)),
        mock.patch.object(old_pm, "datetime", FakeDatetime),
        mock.patch.object(old_pm, "utc_now_iso", lambda: FakeDatetime.now(timezone.utc).isoformat().replace("+00:00", "Z")),
        mock.patch.object(old_pm, "MPV_SOCKET_PATH", sock),
        mock.patch.object(old_pm, "subprocess", types.SimpleNamespace(Popen=mpv.popen, TimeoutExpired=Exception, run=lambda *a, **k: None)),
    ]
    for p in patches:
        p.start()
    player = old_pm.PlayerManager()
    player.reload_manifest_schedule()
    player.start_player(old_common.DEFAULT_STATIC_IMAGE_PATH, loop_forever=False)
    player.transition(old_pm.PlayerState.IDLE, reset_idle_clock=True)

    def run_for(seconds):
        end = clock.t + seconds
        while clock.t < end - 1e-9:
            player.handle_commands()
            player.tick()
            clock.sleep(1)

    for action in json.loads(session_json):
        if action[0] == "idle":
            run_for(action[1])
        elif action[0] == "door":
            player.on_door_sensor()
        elif action[0] == "mute":
            player.on_passenger_button()
    mpv.stop_all()
    entries = old_common.read_jsonl(old_common.PLAYBACK_LOG_PATH)
    monitor = old_hm.HealthMonitor()
    while old_common.read_jsonl(old_common.PLAYBACK_LOG_PATH):
        monitor.upload_logs()  # 1.0.0's own uploader: up to 500 entries per POST
    print(json.dumps({"entries": entries, "loopId": manifest["loopId"]}))


def old_model(session, manifest):
    """What firmware 1.0.0 logs for the session, from its rules (lib/playback-metrics.ts and the
    1.0.0 code): everything is logged when it STARTS, on the player's 1 s ticks; a still each time
    the slot changes while idle (from the idle start) or muted (loop clock); the safety message
    when it starts, with the manifest's duration; on starting or resuming the loop every item that
    has already started is skipped (so slot 0's advert is not logged at the start of a journey).
    Returns a list of {t, kind, assetId}."""
    T = manifest["totalDurationMs"] / 1000.0
    safety = (manifest.get("safetyVideo") or {}).get("durationMs")
    S = safety / 1000.0 if safety else None
    items = sorted(
        ((slot["position"] * 60.0 + c["startTimeMs"] / 1000.0, c) for slot in manifest["slots"] for c in slot["contents"]),
        key=lambda x: x[0],
    )
    out = []
    st = {"name": "IDLE", "origin": 0.0, "L": None, "next": 0, "last": 0.0, "marker": None, "wd": None, "s": None}

    def log(t, kind, asset=None, ms=None):
        out.append({"t": float(t), "kind": kind, "assetId": asset, "durationMs": ms})

    def still_asset(slot):
        sl = next((x for x in manifest["slots"] if x["position"] == slot), {})
        if sl.get("staticImageAssetId"):
            return sl["staticImageAssetId"]
        return next((c["assetId"] for c in sl.get("contents", []) if c["type"] == "ADVERTISEMENT"), None)

    def log_still(t, mode, slot):
        if st["marker"] != (mode, slot):
            st["marker"] = (mode, slot)
            log(t, "still", still_asset(slot))

    def cursor_to(position):
        st["last"] = position
        st["next"] = sum(1 for start, _ in items if start <= position)

    def enter_idle(t):
        st.update(name="IDLE", origin=float(t), marker=None)
        log_still(t, "idle", 0)

    def tick(t):
        name = st["name"]
        if name == "IDLE":
            log_still(t, "idle", int((t - st["origin"]) // 60) % 10)
        elif name == "SAFETY":
            if t - st["s"] >= S - 0.25:
                st.update(name="JOURNEY", L=float(t))
                cursor_to(0.0)
        elif name == "JOURNEY":
            elapsed = (t - st["L"]) % T
            if elapsed + 3 < st["last"]:
                st["next"] = 0
            st["last"] = elapsed
            while st["next"] < len(items) and items[st["next"]][0] <= elapsed:
                c = items[st["next"]][1]
                log(t, "advert" if c["type"] == "ADVERTISEMENT" else "filler", c["assetId"])
                st["next"] += 1
        elif name == "SILENT":
            log_still(t, "silent", int((t - st["L"]) // 60) % 10)
        elif name == "WIND_DOWN" and t - st["wd"] >= 5:
            enter_idle(t)

    t = 0
    enter_idle(0)
    for action in session:
        if action[0] == "idle":
            for _ in range(action[1]):
                tick(t)
                t += 1
        elif action[0] == "door":
            if st["name"] == "IDLE":
                log(t, "journey_start")
                if S:
                    log(t, "safety")
                    st.update(name="SAFETY", s=float(t))
                else:
                    st.update(name="JOURNEY", L=float(t))
                    cursor_to(0.0)
            elif st["name"] == "SAFETY":
                log(t, "journey_end", ms=0)  # 1.0.0 times a journey from the start of the loop
                enter_idle(t)
            elif st["name"] != "WIND_DOWN":
                log(t, "journey_end", ms=int((t - st["L"]) * 1000))
                st.update(name="WIND_DOWN", wd=t)
        elif action[0] == "mute":
            if st["name"] == "JOURNEY":
                st.update(name="SILENT", marker=None)
                log_still(t, "silent", int((t - st["L"]) // 60) % 10)
            elif st["name"] == "SILENT":
                st["name"] = "JOURNEY"
                cursor_to((t - st["L"]) % T)
    return out


def old_counts(entries):
    counts, adverts = Counter(), Counter()
    for e in entries:
        counts[e["kind"]] += 1
        if e["kind"] == "journey_end":
            counts["journey_ms"] += e["durationMs"]
        if e["kind"] == "advert":
            adverts[e["assetId"]] += 1
    return counts, adverts


# ------------------------------------------------------------------------------------------------
# The test
# ------------------------------------------------------------------------------------------------


def main() -> int:
    import requests

    stamp = format(int(time.time() * 1000), "x").upper()[-8:]
    prefix = f"E2E-BILL-{stamp}"
    serial_new, serial_old = f"{prefix}-CAB", f"{prefix}-OLD"
    work = Path(tempfile.mkdtemp(prefix="orison-billing-"))
    created = {"assets": {}, "loops": {}, "groups": [], "devices": {}}
    settings_restore: dict | None = None
    cms = Cms()

    try:
        step("Upload test adverts, fillers, a still and a safety message")
        media = make_media(work, prefix)
        for key, path in media.items():
            category = MEDIA[key][0]
            created["assets"][key] = cms.upload_asset(path, category, {"advertiser": f"{prefix} advertiser"})
        deadline = time.time() + 900
        assets = {}
        while time.time() < deadline:
            assets = {k: cms.call("GET", f"/assets/{i}")[1] for k, i in created["assets"].items()}
            if all(a.get("status") in ("READY", "FAILED") for a in assets.values()):
                break
            time.sleep(2)
        check(all(a.get("status") == "READY" for a in assets.values()), f"{len(assets)} assets processed",
              {k: (a.get("status"), a.get("errorMessage")) for k, a in assets.items() if a.get("status") != "READY"})
        aid = created["assets"]
        print("   durations:", {k: a.get("durationMs") for k, a in assets.items()})

        step("Test groups, test cabs, two ten-slot loops")
        for n in (1, 2):
            _, group = cms.call("POST", "/device-groups", {"name": f"{prefix} group {n}"})
            created["groups"].append(group["id"])
        for serial in (serial_new, serial_old):
            _, dev = cms.call("POST", "/devices", {"serialNumber": serial, "cabLicenseNumber": f"{prefix} TEST"})
            created["devices"][serial] = dev["id"]
        cms.call("PUT", f"/devices/{created['devices'][serial_new]}", {"groupId": created["groups"][0]})
        cms.call("PUT", f"/devices/{created['devices'][serial_old]}", {"groupId": created["groups"][1]})

        def build(spec, name, group_id):
            _, loop = cms.call("POST", "/loops", {"name": name})
            cms.call("POST", f"/loops/{loop['id']}/target", {"targetGroupId": group_id})
            saves = []
            for pos, recipe in enumerate(spec["recipes"]):
                t, contents = 0, []
                for order, (key, kind, ms) in enumerate(recipe):
                    contents.append({"assetId": aid[key], "orderInSlot": order, "startTimeMs": t, "durationMs": ms,
                                     "contentType": "ADVERTISEMENT" if kind == "A" else "FILLER"})
                    t += ms
                assert t == 60000, (pos, t)
                saves.append({"position": pos, "contents": contents,
                              "staticCreativeId": aid["STILL"] if pos in spec["still_slots"] else None})
            cms.call("PUT", f"/loops/{loop['id']}/slots", {"slots": saves})
            return loop["id"]

        def publish(loop_id, label):
            t0 = time.time()
            cms.call("POST", f"/loops/{loop_id}/publish")
            while time.time() - t0 < 1800:
                _, body = cms.call("GET", f"/loops/{loop_id}/publish")
                if body["state"]["publish"]["kind"] != "running":
                    break
                time.sleep(2)
            ok = check(body["state"]["status"] == "PUBLISHED" and not body["state"].get("publishError"),
                       f"{label} published in {time.time() - t0:.0f} s", body["state"].get("publishError"))
            if not ok:
                raise RuntimeError("publish failed")

        step("Safety message (a global setting: configured before publishing, restored right after the cab session)")
        _, settings = cms.call("GET", "/settings")
        if not settings.get("safetyVideoAssetId"):
            settings_restore = dict(settings)
            cms.call("PUT", "/settings", {**settings, "safetyVideoAssetId": aid["SAFETY"]})
            print("   configured the test safety message")
        else:
            print("   a safety message is already configured; using it as it is")

        loop_a = build(LOOP_A, f"{prefix} loop A", created["groups"][0])
        created["loops"]["A"] = loop_a
        loop_b = build(LOOP_B, f"{prefix} loop B", created["groups"][1])
        created["loops"]["B"] = loop_b
        publish(loop_a, "loop A")
        publish(loop_b, "loop B")
        status, answer = cms.device_get("/devices/manifest", serial_new)
        check(status == 200 and answer.get("loopId") == loop_a, "the test cab is told to play loop A", answer)
        safety_desc = answer.get("safetyVideo")
        check(isinstance(safety_desc, dict) and safety_desc.get("durationMs", 0) > 0, "manifest response carries the safety message", safety_desc)
        safety_s = safety_desc["durationMs"] / 1000.0

        # ----------------------------------------------------------------------------------
        step("Cab firmware 1.2.0: sync, player, health monitor")
        base = work / "cab"
        base.mkdir()
        os.environ["ORISON_BASE_DIR"] = str(base)
        (base / "config.json").write_text(json.dumps({
            "device": {"serialNumber": serial_new, "apiBaseUrl": API, "apiToken": DEVICE_TOKEN},
            "sync": {"maxBandwidthBytesPerSec": 0, "downloadTimeoutSeconds": 60},
            "playback": {"trigger": "gpio"}, "location": {"gpsEnabled": False}, "modem": {"atPort": "none"},
            "health": {"heartbeatIntervalSeconds": 300}}))
        sys.path.insert(0, str(DEVICE / "tests"))
        sys.path.insert(0, str(DEVICE))
        import support  # noqa: F401  fake mpv and fake clock; disables service logging
        import common
        import health_monitor
        import player_manager as pm
        import sync_agent
        import sync_signal
        assert common.BASE_DIR == base

        session_minutes = 75
        now = datetime.now(timezone.utc)
        london_midnight = londonday_start(now)
        epoch0 = max(now.timestamp() - session_minutes * 60, london_midnight + 60)
        global EPOCH_SHOW
        EPOCH_SHOW = epoch0
        clock = support.FakeClock()
        clock.t = 0.0
        clock.time = lambda: epoch0 + clock.t  # type: ignore[method-assign]
        sock = str(common.RUNTIME_DIR / "mpv.sock")
        durations = {"safety.mp4": safety_s, "safety.jpg": None}
        mpv = support.MpvFactory(sock, clock, durations)
        for patch in (mock.patch.object(pm, "time", support.make_time_shim(clock)),
                      mock.patch.object(pm, "MPV_SOCKET_PATH", sock),
                      mock.patch.object(pm, "subprocess", types.SimpleNamespace(Popen=mpv.popen))):
            patch.start()

        agent = sync_agent.SyncAgent()
        downloads: list[str] = []
        real_download = agent.download_file

        def recording_download(url, target, *a, **k):
            downloads.append(urllib.parse.urlparse(url).path.rsplit("/", 1)[-1] + " -> " + Path(target).name)
            return real_download(url, target, *a, **k)

        agent.download_file = recording_download
        agent.ensure_boot_content()
        hm = health_monitor.HealthMonitor()
        hm.sync_requester.min_interval_s = 0
        responses: list[dict] = []
        real_post_logs = hm._post_logs

        def recording_post_logs(entries):
            status, body = real_post_logs(entries)
            responses.append({"status": status, "body": body, "n": len(entries)})
            return status, body

        hm._post_logs = recording_post_logs
        upload_fault = {"mode": None}
        lost = {"n": 0}
        real_session_post = hm.session.post

        def faulty_post(url, *a, **k):
            mode = upload_fault["mode"]
            if url.endswith("/devices/playback-log") and mode:
                upload_fault["mode"] = None
                if mode == "refuse":
                    raise requests.ConnectionError("simulated: no network")
                response = real_session_post(url, *a, **k)  # the server stores it...
                lost["n"] += len(json.loads(k["data"])["logs"]) if response.ok else 0
                raise requests.ConnectionError("simulated: connection lost before the response arrived")
            return real_session_post(url, *a, **k)

        hm.session.post = faulty_post

        player = pm.PlayerManager()
        player.trigger = "gpio"
        player.reload_timeline()
        player.start_initial_state(clock.t)
        model = Model(epoch0, serial_new)
        all_written: list[dict] = []

        def run_for(seconds):
            end = clock.t + seconds
            while clock.t < end - 1e-9:
                player.step()
                clock.sleep(1)

        def sync_now(label):
            before = len(downloads)
            command_before = (common.read_json(common.PLAYER_STATE_PATH, {}) or {}).get("lastHandledCommandId")
            result = {}
            thread = threading.Thread(target=lambda: result.update(delay=agent.sync_once()))
            thread.start()
            while thread.is_alive():
                player.step()
                time.sleep(0.05)
            player.step()
            command_after = (common.read_json(common.PLAYER_STATE_PATH, {}) or {}).get("lastHandledCommandId")
            status = common.read_json(common.SYNC_STATUS_PATH, {})
            return downloads[before:], command_after != command_before and str(command_after).startswith("reload-"), status

        def local_manifest():
            return common.read_json(common.current_manifest_path(), {})

        def upload(how):
            pending = hm.queue.pending_count()
            if how in ("refuse", "lose-response"):
                upload_fault["mode"] = how
                hm.upload_logs()
                hm.upload_retry_at = 0
            if how == "resend":
                hm.queue.rotate()
                segment = hm.queue.segments()[0]
                saved = hm.queue.read_segment(segment)
            hm.upload_logs()
            if how == "resend":
                outcome = hm.post_batch(saved)  # the same batch again, as after a lost response
                check(outcome == "ok", f"re-sent batch of {len(saved)} accepted (as duplicates)")
            left = hm.queue.pending_count()
            check(left == 0, f"upload ({how}): {pending} entries queued, {left} left", hm.queue.status())

        def collect_written():
            # Everything the player wrote that has not been sent yet (ground truth for "nothing lost").
            for seg in hm.queue.segments():
                all_written.extend(common.read_jsonl(seg))
            all_written.extend(common.read_jsonl(common.PLAYBACK_LOG_PATH))

        def heartbeat(expect_reasons=None):
            sync_signal.consume_sync_request(sync_signal.SYNC_REQUEST_PATH)
            body = hm.send_heartbeat()
            request = sync_signal.consume_sync_request(sync_signal.SYNC_REQUEST_PATH)
            reasons = (request or {}).get("reasons")
            if expect_reasons is None:
                check(request is None, "heartbeat: server and cab agree (no sync requested)", reasons)
            else:
                check(bool(reasons) and set(expect_reasons) <= set(reasons), f"heartbeat asks for a sync ({expect_reasons})", reasons)
            return body

        def run_session(actions):
            for action in actions:
                if action[0] == "idle":
                    run_for(action[1])
                    model.idle(action[1])
                elif action[0] == "door":
                    player.on_door_sensor()
                    model.door()
                elif action[0] == "mute":
                    player.on_passenger_button()
                    model.mute()

        # First sync: nothing on the cab yet.
        got, reloaded, status = sync_now("first")
        manifest_a = local_manifest()
        check(manifest_a.get("loopId") == loop_a and reloaded and status.get("state") == "ok",
              "SyncAgent downloaded, verified and activated loop A; the real player confirmed it", status)
        check(manifest_a.get("formatVersion") == 2 and manifest_a.get("slotCount") == 10, "loop A manifest is formatVersion 2 with 10 slots")
        check(any("loop.mp4" in d for d in got) and sum("slot_" in d for d in got) == 2,
              f"one video and two distinct stills downloaded (shared branded still once): {len(got)} files", got)
        durations["loop.mp4"] = manifest_a["totalDurationMs"] / 1000.0
        check(player.timeline.loop_id == loop_a and player.timeline.format_version == 2, "player follows the formatVersion 2 timing")
        check([round(i["startMs"]) for i in player.timeline.items] == [c["absoluteStartMs"] for s in manifest_a["slots"] for c in s["contents"]],
              "player item starts are the manifest's absoluteStartMs")
        model.start(manifest_a, safety_s)
        hb = heartbeat()
        check(hb and hb.get("expectedLoopId") == loop_a, "heartbeat accepted; server expects loop A")

        step("Session 1 on loop A (journeys, mute, wrap)")
        run_session(SESSION_1)
        collect_written()
        upload("refuse")

        step("Loop change: the cab moves to group 2 (loop B)")
        cms.call("PUT", f"/devices/{created['devices'][serial_new]}", {"groupId": created["groups"][1]})
        heartbeat(expect_reasons=["loopId"])
        model_reload_at = clock.t
        got, reloaded, status = sync_now("loop B")
        manifest_b = local_manifest()
        check(manifest_b.get("loopId") == loop_b and reloaded, "loop B downloaded and activated while idle", status)
        check(not any("safety" in d for d in got), "the safety message was not downloaded again", got)
        model.reload(manifest_b, safety_s)
        _ = model_reload_at
        heartbeat()

        step("Session 2 on loop B")
        run_session(SESSION_2)
        collect_written()
        upload("lose-response")

        step("Republish loop B unchanged: no sync at all")
        loads_before = mpv.current.loadfile_count()
        publish(loop_b, "loop B (unchanged)")
        status, answer = cms.device_get("/devices/manifest", serial_new)
        check(answer.get("checksum") == manifest_b["checksum"], "server tells the cab exactly what it told it before")
        heartbeat()
        got, reloaded, status = sync_now("unchanged")
        check(got == [] and not reloaded, "sync downloaded nothing and did not reload the player", got)
        check(common.read_json(common.PLAYER_STATE_PATH, {}).get("lastHandledAction") != "reload" and mpv.current.loadfile_count() == loads_before,
              "the player was not told to reload and loaded nothing")

        step("Republish loop B with only a still changed: manifest only, no video download")
        _, loop_row = cms.call("GET", f"/loops/{loop_b}")
        slot = next(s for s in loop_row["slots"] if s["position"] == LOOP_B_REPUBLISH_STILL_SLOT)
        cms.call("PUT", f"/loops/{loop_b}/slots", {"slots": [{
            "position": slot["position"], "staticCreativeId": aid["STILL"], "expectedUpdatedAt": slot.get("updatedAt"),
            "contents": [{k: c[k] for k in ("assetId", "orderInSlot", "startTimeMs", "durationMs", "contentType")} for c in slot["contents"]]}]})
        publish(loop_b, "loop B (still changed)")
        heartbeat(expect_reasons=["checksum"])
        got, reloaded, status = sync_now("manifest only")
        manifest_b2 = local_manifest()
        check(manifest_b2.get("checksum") != manifest_b["checksum"] and manifest_b2.get("compiledVideoChecksum") == manifest_b["compiledVideoChecksum"],
              "new manifest, same compiled video checksum")
        check(not any("loop.mp4" in d for d in got) and any("manifest" in d for d in got), f"downloaded: {got}")
        check(manifest_b2["slots"][LOOP_B_REPUBLISH_STILL_SLOT].get("staticImageAssetId") == aid["STILL"], "slot 4 now has the still")
        model.reload(manifest_b2, safety_s)
        heartbeat()

        step("Session 3 on loop B (republished)")
        run_session(SESSION_3)
        player.shutdown("shutdown")
        model.shutdown()
        collect_written()
        upload("resend")

        step("Always mode (no passenger detection), more than one full pass, with the safety message")
        mpv.stop_all()
        clock.sleep(30)
        always_start = clock.t
        player = pm.PlayerManager()
        player.trigger = "always"
        player.reload_timeline()
        player.start_initial_state(clock.t)
        last_end = max(c["absoluteStartMs"] + c["durationMs"] for s in manifest_b2["slots"] for c in s["contents"]) / 1000.0
        always_run = math.ceil(safety_s) + math.ceil(last_end) + math.ceil(safety_s) + ALWAYS_SECONDS_AFTER_FIRST_PASS
        run_for(always_run)
        player.shutdown("shutdown")
        model.always(always_start, always_run)
        collect_written()
        hb = heartbeat()
        check(common.read_json(common.PLAYER_STATE_PATH, {}).get("trigger") == "always", "player reports trigger always")
        upload("normal")
        mpv.stop_all()

        if settings_restore is not None:
            _, current = cms.call("GET", "/settings")
            cms.call("PUT", "/settings", {**current, "safetyVideoAssetId": settings_restore.get("safetyVideoAssetId")})
            settings_restore = None
            print("   safety message setting restored")

        # ----------------------------------------------------------------------------------
        step("Firmware 1.0.0 (from git history) runs session 1 on loop B and uploads its log")
        old_dir = work / "fw-1.0.0"
        old_dir.mkdir()
        for name in ("common.py", "player_manager.py", "health_monitor.py", "orison_static_fallback.jpg"):
            blob = subprocess.run(["git", "-C", str(REPO), "show", f"{OLD_FIRMWARE_COMMIT}:device/{name}"], capture_output=True, check=True).stdout
            (old_dir / name).write_bytes(blob)
        # The old cab reports the loop it plays (1.0.0 heartbeat): its rows get that loop.
        old_hb = {"serialNumber": serial_old, "firmwareVersion": "1.0.0", "currentLoopId": loop_b, "playerStatus": "idle",
                  "networkType": "4g", "signalStrength": 62, "location": {"method": "network_manager", "signalStrength": 62}}
        r = requests.post(f"{API}/devices/heartbeat", headers={"Authorization": f"Bearer {DEVICE_TOKEN}", "X-Device-Serial": serial_old,
                          "Content-Type": "application/json"}, data=json.dumps(old_hb), timeout=30)
        check(r.ok, "1.0.0-style heartbeat accepted", r.text[:200])
        old_base = work / "old-cab"
        old_base.mkdir()
        env = {**os.environ, "ORISON_BASE_DIR": str(old_base)}
        result = subprocess.run([sys.executable, __file__, "--old-firmware-runner", str(old_dir), str(old_base), str(common.CURRENT_DIR),
                                 json.dumps(SESSION_1), str(epoch0), serial_old, API], capture_output=True, text=True, env=env, timeout=600)
        if result.returncode != 0:
            raise RuntimeError(f"firmware 1.0.0 run failed: {result.stderr[-2000:]}")
        old_run = json.loads(result.stdout.strip().splitlines()[-1])
        print(f"   1.0.0 wrote {len(old_run['entries'])} entries")

        # ----------------------------------------------------------------------------------
        step("What the server stored")
        dev_new, dev_old = created["devices"][serial_new], created["devices"][serial_old]
        rows = psql_json(f'''SELECT "deviceId", "loopId", "slotPosition", "contentType"::text AS "contentType", "assetId",
               "playbackType", "eventName", mode, "playerState", extract(epoch from "playedAt")::float8 AS "playedAt",
               "completedFull", "durationMs", "journeyId", "eventId" FROM "PlaybackLog"
               WHERE "deviceId" IN ('{dev_new}', '{dev_old}') ORDER BY "playedAt", id''')
        new_rows = [r for r in rows if r["deviceId"] == dev_new]
        old_rows = [r for r in rows if r["deviceId"] == dev_old]
        written_ids = [e["eventId"] for e in all_written]
        stored_ids = [r["eventId"] for r in new_rows]
        check(len(written_ids) == len(set(written_ids)), f"player wrote {len(written_ids)} entries, all with distinct eventIds")
        check(Counter(stored_ids) == Counter(written_ids), f"server stored exactly those {len(stored_ids)} (nothing lost, nothing twice)",
              {"missing": len(set(written_ids) - set(stored_ids)), "extra": len(stored_ids) - len(set(stored_ids))})
        accepted = sum((r["body"] or {}).get("accepted", 0) for r in responses if r["status"] == 200)
        duplicates = sum((r["body"] or {}).get("duplicates", 0) for r in responses if r["status"] == 200)
        rejected = sum(len((r["body"] or {}).get("rejected", [])) for r in responses if r["status"] == 200)
        resent = [r for r in responses if r["status"] == 200 and (r["body"] or {}).get("duplicates")]
        check(rejected == 0, f"server rejected no entry ({rejected})")
        check(accepted + lost["n"] == len(stored_ids), f"accepted ({accepted}) + the batch whose response was lost ({lost['n']}) = stored", len(stored_ids))
        check(duplicates > 0 and len(resent) == 2, f"re-sent entries recognised as duplicates: {duplicates} in {len(resent)} batches (lost response + deliberate re-send)")
        check(len(old_rows) == len(old_run["entries"]), f"1.0.0 rows stored: {len(old_rows)} of {len(old_run['entries'])}")
        check(all(r["loopId"] == loop_b and r["eventId"] is None for r in old_rows), "1.0.0 rows: loop from the cab's reported loop, no eventId")

        # Entry by entry: model vs stored (new firmware).
        unmatched_model, unmatched_rows = match_entries(model.entries, new_rows)
        check(not unmatched_model and not unmatched_rows,
              f"every stored row is a play the model expects and vice versa ({len(model.entries)} expected, {len(new_rows)} stored)",
              {"expected-not-stored": unmatched_model[:6], "stored-not-expected": unmatched_rows[:6]})

        step("Analytics and CSV export against the independent figures")
        exp = expected_figures(model.entries)
        old_expected = old_model(SESSION_1, manifest_b2)
        old_logged = [{"t": round(datetime.fromisoformat(e["playedAt"].replace("Z", "+00:00")).timestamp() - epoch0, 3),
                       "kind": kind_of(e), "assetId": e.get("assetId")} for e in old_run["entries"]]
        key = lambda e: (round(e["t"], 1), e["kind"], e["assetId"])  # noqa: E731
        missing = Counter(map(key, old_expected)) - Counter(map(key, old_logged))
        extra = Counter(map(key, old_logged)) - Counter(map(key, old_expected))
        check(not missing and not extra, f"firmware 1.0.0 logged what its rules predict ({len(old_expected)} entries)",
              {"expected-not-logged": sorted(missing)[:8], "logged-not-expected": sorted(extra)[:8]})
        exp_old, exp_old_adverts = old_counts(old_expected)
        csv_rows = export_rows(cms, {serial_new, serial_old}, epoch0)
        report = []
        compare_csv(csv_rows, exp, exp_old, exp_old_adverts, serial_new, serial_old, report, aid, {loop_a: "A", loop_b: "B"})
        compare_analytics(baseline, analytics_snapshot(), baseline_marker, other_rows_marker(list(created["devices"].values())),
                          exp, exp_old, exp_old_adverts, aid, report)
        print("\n   figure                                   expected   reported")
        for name, want, got in report:
            print(f"   {name:<40} {str(want):>9} {str(got):>10}  {'' if want == got else '<-- differs'}")
    except Exception as error:  # noqa: BLE001
        global checks_failed
        checks_failed += 1
        import traceback

        traceback.print_exc()
        print(f"  FAIL {error}")
    finally:
        cleanup(cms, created, settings_restore, prefix)
        if os.environ.get("KEEP_WORK"):
            print(f"   work directory kept: {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
    print(f"\n{checks_failed} check(s) failed" if checks_failed else "\nAll checks passed")
    return 1 if checks_failed else 0


baseline: dict = {}
baseline_marker = ""


def londonday_start(now: datetime) -> float:
    try:
        from zoneinfo import ZoneInfo

        local = now.astimezone(ZoneInfo("Europe/London"))
        return local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    except Exception:  # noqa: BLE001
        return now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def kind_of(entry) -> str:
    if entry.get("event") == "JOURNEY_START":
        return "journey_start"
    if entry.get("event") == "JOURNEY_END":
        return "journey_end"
    if entry.get("type") in ("SAFETY", "SAFETY_MESSAGE"):
        return "safety"
    if entry.get("type") == "STATIC_IMAGE" or entry.get("mode") in ("idle", "silent"):
        return "still"
    if entry.get("contentType") == "ADVERTISEMENT":
        return "advert"
    if entry.get("contentType") == "FILLER":
        return "filler"
    return "other"


def match_entries(expected: list[dict], rows: list[dict]):
    def key(e):
        return (kind_of({"event": e.get("eventName", e.get("event")), "type": e.get("playbackType", e.get("type")),
                         "mode": e.get("mode"), "contentType": e.get("contentType")}),
                e.get("assetId"), e.get("slotPosition"), e.get("mode"), e.get("loopId"))

    pool = defaultdict(list)
    for r in rows:
        pool[key(r)].append(r)
    missing = []
    for e in expected:
        candidates = pool.get(key(e), [])
        hit = next((r for r in candidates if abs(r["playedAt"] - e["playedAt"]) < 0.01
                    and abs((r["durationMs"] or 0) - e["durationMs"]) <= 1 and r["completedFull"] == e["completedFull"]), None)
        if hit is None:
            near = min(candidates, key=lambda r: abs(r["playedAt"] - e["playedAt"]), default=None)
            missing.append({"expected": {**e, "playedAt": round(e["playedAt"] - EPOCH_SHOW, 3)},
                            "nearest": near and {"playedAt": round(near["playedAt"] - EPOCH_SHOW, 3), "durationMs": near["durationMs"],
                                                 "completedFull": near["completedFull"]}})
        else:
            candidates.remove(hit)
    extra = [{**r, "playedAt": round(r["playedAt"] - EPOCH_SHOW, 3)} for rs in pool.values() for r in rs]
    return missing, extra


EPOCH_SHOW = 0.0


def expected_figures(entries):
    figures = Counter()
    per_advert = defaultdict(lambda: Counter())
    per_loop = Counter()
    for e in entries:
        kind = kind_of(e)
        figures[kind] += 1
        per_loop[(e["loopId"], kind)] += 1
        if kind == "advert":
            figures["advert_completed"] += e["completedFull"]
            figures["advert_ms"] += e["durationMs"]
            per_advert[e["assetId"]]["plays"] += 1
            per_advert[e["assetId"]]["completed"] += e["completedFull"]
            per_advert[e["assetId"]]["ms"] += e["durationMs"]
        if kind == "still":
            figures["still_with_asset" if e["assetId"] else "still_no_asset"] += 1
        if kind == "journey_end":
            figures["journey_ms"] += e["durationMs"]
    return {"figures": figures, "per_advert": per_advert, "per_loop": per_loop}


def export_rows(cms: Cms, serials: set[str], epoch0: float):
    day = datetime.fromtimestamp(epoch0, timezone.utc)
    try:
        from zoneinfo import ZoneInfo

        day = day.astimezone(ZoneInfo("Europe/London"))
    except Exception:  # noqa: BLE001
        pass
    first = day.strftime("%Y-%m-%d")
    last = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")
    r = cms.http.get(f"{API}/analytics/export", params={"from": first, "to": last}, timeout=300)
    check(r.status_code == 200, f"CSV export {first}..{last} answered {r.status_code}")
    reader = csv.DictReader(io.StringIO(r.text))
    return [row for row in reader if row["cabSerial"] in serials]


LABEL = {"advert": "advert_play", "filler": "filler_play", "still": "still_showing", "safety": "safety_message",
         "journey_start": "journey_start", "journey_end": "journey_end"}


def compare_csv(rows, exp, exp_old, exp_old_adverts, serial_new, serial_old, report, aid, loop_names):
    new = [r for r in rows if r["cabSerial"] == serial_new]
    old = [r for r in rows if r["cabSerial"] == serial_old]
    f = exp["figures"]
    by = Counter(r["countsAs"] for r in new)
    for kind in ("advert", "filler", "still", "safety", "journey_start", "journey_end"):
        report.append((f"CSV 1.2.0 cab: {LABEL[kind]}", f[kind], by[LABEL[kind]]))
    ads = [r for r in new if r["countsAs"] == "advert_play"]
    report.append(("CSV 1.2.0 cab: adverts complete", f["advert_completed"], sum(r["completedFull"] == "true" for r in ads)))
    report.append(("CSV 1.2.0 cab: advert seconds on screen", f["advert_ms"] / 1000, sum(int(r["durationMs"]) for r in ads) / 1000))
    report.append(("CSV 1.2.0 cab: adverts measured", f["advert"], sum(r["measured"] == "yes" for r in ads)))
    stills = [r for r in new if r["countsAs"] == "still_showing"]
    report.append(("CSV 1.2.0 cab: stills with no asset", f["still_no_asset"], sum(not r["assetId"] for r in stills)))
    report.append(("CSV 1.2.0 cab: stills of the still creative", f["still_with_asset"], sum(r["assetId"] == aid["STILL"] for r in stills)))
    for key, asset_id in aid.items():
        if key.startswith("AD"):
            want = exp["per_advert"].get(asset_id, Counter())
            mine = [r for r in ads if r["assetId"] == asset_id]
            report.append((f"CSV 1.2.0 cab: {key} plays / complete", (want["plays"], want["completed"]),
                           (len(mine), sum(r["completedFull"] == "true" for r in mine))))
    for (loop_id, kind), count in sorted(exp["per_loop"].items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
        if kind in ("advert", "still"):
            report.append((f"CSV 1.2.0 cab: loop {loop_names.get(loop_id, loop_id)} {LABEL[kind]}", count,
                           sum(1 for r in new if r["loopId"] == loop_id and r["countsAs"] == LABEL[kind])))
    by_old = Counter(r["countsAs"] for r in old)
    for kind in ("advert", "filler", "still", "journey_start", "journey_end"):
        report.append((f"CSV 1.0.0 cab: {LABEL[kind]}", exp_old[kind], by_old[LABEL[kind]]))
    report.append(("CSV 1.2.0 cab: journey seconds (sum)", f["journey_ms"] / 1000,
                   sum(int(r["durationMs"]) for r in new if r["countsAs"] == "journey_end") / 1000))
    report.append(("CSV 1.0.0 cab: journey seconds (sum)", exp_old["journey_ms"] / 1000,
                   sum(int(r["durationMs"]) for r in old if r["countsAs"] == "journey_end") / 1000))
    report.append(("CSV 1.0.0 cab: rows marked measured", 0, sum(r["measured"] == "yes" for r in old)))
    report.append(("CSV 1.0.0 cab: stills counted as advert plays", 0,
                   sum(1 for r in old if r["mode"] in ("idle", "silent") and r["countsAs"] == "advert_play")))


def compare_analytics(before, after, marker_before, marker_after, exp, exp_old, exp_old_adverts, aid, report):
    f = exp["figures"]
    breakdown = {row["assetId"]: row for row in after["adBreakdown"]}
    for key, asset_id in aid.items():
        if not key.startswith("AD"):
            continue
        want = exp["per_advert"].get(asset_id, Counter())
        old_plays = exp_old_adverts.get(asset_id, 0)
        row = breakdown.get(asset_id, {})
        pct = math.floor(want["completed"] / want["plays"] * 100 + 0.5) if want["plays"] else None  # Math.round
        report.append((f"Analytics: {key} plays (both cabs)", want["plays"] + old_plays, row.get("plays", 0)))
        report.append((f"Analytics: {key} measured plays", want["plays"], row.get("measuredPlays", 0)))
        report.append((f"Analytics: {key} completion %", pct, row.get("completionPercent")))
    if marker_before != marker_after:
        print("   (other cabs wrote playback rows during the test: fleet-wide totals are not compared)")
        return
    delta = lambda path: dig(after, path) - dig(before, path)  # noqa: E731
    report.append(("Analytics: advert plays (delta)", f["advert"] + exp_old["advert"], delta("totals.advertPlays")))
    report.append(("Analytics: still showings (delta)", f["still"] + exp_old["still"], delta("totals.stillShowings")))
    report.append(("Analytics: filler plays (delta)", f["filler"] + exp_old["filler"], delta("totals.fillerPlays")))
    report.append(("Analytics: safety messages (delta)", f["safety"] + exp_old.get("safety", 0), delta("totals.safetyPlays")))
    report.append(("Analytics: journeys today (delta)", f["journey_start"] + exp_old["journey_start"], delta("journeyMetrics.today")))
    report.append(("Analytics: measured advert plays (delta)", f["advert"], delta("completion.measuredPlays")))
    report.append(("Analytics: measured complete (delta)", f["advert_completed"], delta("completion.completedPlays")))


def dig(data, path):
    for part in path.split("."):
        data = data[part]
    return data or 0


def cleanup(cms: Cms, created, settings_restore, prefix):
    step("Clean up")
    if settings_restore is not None:
        try:
            _, current = cms.call("GET", "/settings")
            cms.call("PUT", "/settings", {**current, "safetyVideoAssetId": settings_restore.get("safetyVideoAssetId")})
            print("   safety message setting restored")
        except Exception as error:  # noqa: BLE001
            print(f"   COULD NOT RESTORE the safety message setting: {error}")
    for name, loop_id in created["loops"].items():
        try:
            for _ in range(900):  # a publish still running cannot be deleted: let it finish
                _, state = cms.call("GET", f"/loops/{loop_id}/publish", ok=None)
                if ((state.get("state") or {}).get("publish") or {}).get("kind") != "running":
                    break
                time.sleep(2)
            if (state.get("state") or {}).get("status") == "PUBLISHED":
                _, first = cms.call("POST", f"/loops/{loop_id}/pause", {}, ok=None)
                if first.get("token"):
                    cms.call("POST", f"/loops/{loop_id}/pause", {"token": first["token"]}, ok=None)
            status, _ = cms.call("DELETE", f"/loops/{loop_id}", ok=None)
            print(f"   loop {name}: {status}")
        except Exception as error:  # noqa: BLE001
            print(f"   loop {name}: {error}")
    ids = ",".join(f"'{i}'" for i in created["devices"].values())
    if ids and DATABASE_URL:
        try:
            psql(f'DELETE FROM "PlaybackLog" WHERE "deviceId" IN ({ids})')
            psql(f'DELETE FROM "Device" WHERE id IN ({ids})')
            print(f"   cabs and their playback rows deleted: {', '.join(created['devices'])}")
        except Exception as error:  # noqa: BLE001
            print(f"   could not delete the test cabs: {error}")
    for key, asset_id in created["assets"].items():
        status, body = cms.call("DELETE", f"/assets/{asset_id}", ok=None)
        if status != 200:
            print(f"   asset {key}: {status} {body}")
    for group_id in created["groups"]:
        cms.call("DELETE", f"/device-groups/{group_id}", ok=None)
    # Local-disk storage (development) deletes objects but leaves their folders behind.
    storage = REPO / "apps/web/tmp/storage"
    for folder in [*(storage / "loops" / i for i in created["loops"].values()), *(storage / "manifests" / i for i in created["loops"].values()),
                   *(storage / "assets" / i for i in created["assets"].values())]:
        try:
            folder.rmdir()
        except OSError:
            pass
    if DATABASE_URL:
        try:
            psql(f'DELETE FROM "ActivityEvent" WHERE message LIKE \'%{prefix}%\'')
        except Exception as error:  # noqa: BLE001
            print(f"   could not delete activity entries: {error}")
    left = psql(f'''SELECT (SELECT count(*) FROM "Device" WHERE "serialNumber" LIKE '{prefix}%') || '/' ||
                           (SELECT count(*) FROM "Loop" WHERE name LIKE '{prefix}%') || '/' ||
                           (SELECT count(*) FROM "Asset" WHERE filename LIKE '{prefix}%') || '/' ||
                           (SELECT count(*) FROM "DeviceGroup" WHERE name LIKE '{prefix}%')''') if DATABASE_URL else "?"
    check(left == "0/0/0/0", f"nothing left behind (cabs/loops/assets/groups: {left})")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--old-firmware-runner":
        old_firmware_runner(sys.argv[2:])
        sys.exit(0)
    if not DATABASE_URL:
        sys.exit("DATABASE_URL is required (set -a && . ./.env && set +a)")
    baseline = analytics_snapshot()
    sys.path.insert(0, str(DEVICE))
    baseline_marker = other_rows_marker([])
    sys.exit(main())
