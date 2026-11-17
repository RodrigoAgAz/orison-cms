"""End-to-end simulation of one cab against a running local CMS.

Runs the real firmware services from device/ (health monitor, sync agent and player manager) in a
temporary ORISON_BASE_DIR, with a fake modem and the fake mpv from device/tests (so no screen is
needed), and drives the CMS through the mobile API the way the phone app does. The player runs
in `always` mode, as the real x86 cab does (no passenger detection). It checks that a heartbeat
registers the cab with a GPS position, that content is downloaded, verified and activated (the
real player confirms), that the server stores the player's state, trigger and sync state, that
the playback log is accepted, that an override, a pause and a resume made from the app reach the
cab on its next heartbeat, and that the cell-tower fallback is accepted.

Needs: the web app running (DEMO_BASE_URL, default http://localhost:3000), a published fleet
loop plus one other published loop (npm run demo:seed), ffmpeg, and python3 with requests and
psutil. Run: python3 scripts/demo/simulate-cab.py
With DATABASE_URL set (set -a && . ./.env && set +a) the simulated cab (serial SIM-CAB-E2E) and
its playback rows are deleted at the end; otherwise delete it from the Devices page.
"""
import json, os, sys, threading, time, tempfile, subprocess, shutil
from pathlib import Path

BASE = Path(tempfile.mkdtemp(prefix="orison-sim-"))
os.environ["ORISON_BASE_DIR"] = str(BASE)
DEVICE = Path(__file__).resolve().parents[2] / "device"
sys.path.insert(0, str(DEVICE / "tests"))
sys.path.insert(0, str(DEVICE))
import types
import requests

API = os.environ.get("DEMO_BASE_URL", "http://localhost:3000").rstrip("/") + "/api"
TOKEN = os.environ.get("DEVICE_SHARED_TOKEN", "local-device-token")
ADMIN_EMAIL = os.environ.get("DEFAULT_ADMIN_EMAIL", "admin@orisonscreens.com")
ADMIN_PASSWORD = os.environ.get("DEFAULT_ADMIN_PASSWORD", "ChangeMe123!")
SERIAL = "SIM-CAB-E2E"
fallback = BASE / "fallback.mp4"
subprocess.run(["ffmpeg","-loglevel","error","-f","lavfi","-i","color=c=black:s=320x200:d=1","-y",str(fallback)],check=True)
(BASE/"config.json").write_text(json.dumps({
  "device":{"serialNumber":SERIAL,"apiBaseUrl":API,"apiToken":TOKEN,"cdnBaseUrl":""},
  "sync":{"checkIntervalSeconds":1800,"maxDownloadRetries":3,"downloadTimeoutSeconds":60,"maxBandwidthBytesPerSec":50000000},
  "playback":{"trigger":"always","loopContinuously":True,"screenResolution":"1280x800","fallbackContentPath":str(fallback)},
  "health":{"heartbeatIntervalSeconds":300,"logUploadIntervalSeconds":3600,"maxLogRetentionDays":30}}))

import support  # the fake mpv from device/tests (it also silences the services' logging)
import common, health_monitor, player_manager, sync_agent
from common import PLAYER_STATE_PATH, current_manifest_path, installed_safety, read_json

# ---- the real player, on a fake mpv that keeps real time (old keys above are ignored by 1.2.0)
class RealClock:
    @property
    def t(self): return time.monotonic()
class MediaDurations(dict):
    """What the fake mpv reports as each file's length: the loop's from its manifest."""
    def get(self, name, default=None):
        if name == "loop.mp4":
            total = (read_json(current_manifest_path(), {}) or {}).get("totalDurationMs")
            return total / 1000.0 if total else 8.0
        if name in ("safety.mp4", "safety.jpg"):
            return ((installed_safety() or {}).get("durationMs") or 8000) / 1000.0
        return default
mpv = support.MpvFactory(str(common.RUNTIME_DIR / "mpv.sock"), RealClock(), MediaDurations())
player_manager.MPV_SOCKET_PATH = str(common.RUNTIME_DIR / "mpv.sock")
player_manager.subprocess = types.SimpleNamespace(Popen=mpv.popen)
stop = threading.Event()
player = player_manager.PlayerManager()
player.trigger = player.config.playback_trigger  # "always" (no GPIO, no terminal: the real x86 cab)
def run_player():
    common.ensure_directories()
    player.reload_timeline()
    player.start_initial_state(time.monotonic())
    player.write_state(force=True)
    while not stop.is_set():
        try:
            player.step()
        except Exception as error:  # noqa: BLE001
            print("player error:", error)
        time.sleep(0.2)
    player.shutdown("shutdown")
    mpv.stop_all()
threading.Thread(target=run_player, daemon=True).start()

# ---- fake modem
modem = {"gps": "fix"}
QENG = '+QENG: "servingcell","NOCONN","LTE","FDD",234,10,1A2B3C4,123,1300,3,5,5,3039,-95,-10,-65,12,32\r\n\r\nOK\r\n'
def fake_at(self, port, command, timeout_s=1.5):
    if "QENG" in command: return QENG
    if command == "AT+QGPS?": return "+QGPS: 1\r\n\r\nOK\r\n"
    if "QGPSLOC" in command:
        if modem["gps"] == "fix":
            t = time.gmtime()
            return "+QGPSLOC: %s.0,51.50330,-0.11950,1.2,20.0,3,0.00,12.5,6.7,%s,09\r\n\r\nOK\r\n" % (time.strftime("%H%M%S", t), time.strftime("%d%m%y", t))
        return "+CME ERROR: 516\r\n"
    return "OK\r\n"
port = BASE / "ttyFAKE"; port.write_text("")
health_monitor.AT_PORT_CANDIDATES = [port]
health_monitor.HealthMonitor.run_at_command = fake_at
health_monitor.platform.system = lambda: "Linux"

hm = health_monitor.HealthMonitor()
hm.sync_requester.min_interval_s = 0  # the 120s limit is unit-tested; keep the simulation quick
log_responses = []
_post_logs = hm._post_logs
def recording_post_logs(entries):
    status, body = _post_logs(entries)
    log_responses.append((status, body, len(entries)))
    return status, body
hm._post_logs = recording_post_logs

admin = requests.Session()
r = admin.post(f"{API}/auth/login", json={"email":ADMIN_EMAIL,"password":ADMIN_PASSWORD}); r.raise_for_status()
def cab():
    ov = admin.get(f"{API}/m/overview").json()
    return next((c for c in ov["cabs"] if c["serialNumber"] == SERIAL), None), ov
def local_loop(): return (read_json(current_manifest_path(), {}) or {}).get("loopId")
def wait(pred, secs=40, what=""):
    end = time.time()+secs
    while time.time() < end:
        if pred(): return True
        time.sleep(0.5)
    raise AssertionError("timed out: " + what)
ok = lambda m: print("PASS", m)

try:
    hm.send_heartbeat()                                  # registers the cab
    c, ov = cab(); assert c, "cab not registered by heartbeat"
    fleet = ov["fleetLoop"]["id"]
    assert c["location"] and c["location"]["source"] == "gps" and abs(c["location"]["lat"]-51.5033) < 1e-3, c["location"]
    ok(f"heartbeat registered cab; server stored GPS position {c['location']['lat']},{c['location']['lng']} acc {c['location']['accuracyM']}m")

    agent = sync_agent.SyncAgent()
    threading.Thread(target=agent.run, daemon=True).start()
    wait(lambda: local_loop() == fleet, what="initial sync to fleet loop")
    ok("sync agent downloaded and activated the fleet loop (checksums verified by firmware)")
    # The new content is in place before the player confirms it; the sync is "ok" only after that.
    wait(lambda: (read_json(common.SYNC_STATUS_PATH, {}) or {}).get("state") == "ok", what="sync confirmed by the player")
    wait(lambda: (read_json(PLAYER_STATE_PATH, {}) or {}).get("state") in ("SAFETY", "JOURNEY"), what="player playing")
    hm.send_heartbeat(); c,_ = cab()
    assert c["status"] == "online" and c["isUpToDate"] and c["playing"]["id"] == fleet, c
    assert not (common.RUNTIME_DIR/"sync_request.json").exists()
    ok("server reports cab online and up to date; no sync requested")
    d = admin.get(f"{API}/devices/{c['id']}").json()
    assert d["playbackTrigger"] == "always" and d["playerStatus"] == "playing" and d["playerState"] in ("SAFETY", "JOURNEY"), d
    assert d["syncState"] == "ok" and d["lastSyncAt"] and d["firmwareVersion"] == common.FIRMWARE_VERSION, d
    ok(f"server stored the player's state ({d['playerStatus']}/{d['playerState']}), trigger {d['playbackTrigger']}, sync {d['syncState']} (last synced {d['lastSyncAt']})")

    loop_seconds = (read_json(current_manifest_path(), {}) or {}).get("totalDurationMs", 8000) / 1000.0
    wait(lambda: player.queue.pending_count() >= 2, secs=loop_seconds * 2 + 20, what="playback entries written")
    hm.upload_logs()
    accepted = sum((b or {}).get("accepted", 0) for st, b, n in log_responses if st == 200)
    assert accepted >= 2 and not any((b or {}).get("rejected") for st, b, n in log_responses), log_responses
    ok(f"playback log uploaded: {accepted} entries accepted (mode continuous, measured durations)")

    other = next(l for l in admin.get(f"{API}/m/loops").json()["items"] if l["id"] != fleet and l["status"] == "PUBLISHED")
    r = admin.post(f"{API}/m/assign", json={"loopId": other["id"], "target": {"type":"cab","deviceId": c["id"]}}); assert r.ok, r.text
    c,_ = cab(); assert c["status"] == "updating" and c["expectedSource"] == "cab", c
    ok(f"phone-style override set to '{other['name']}'; server shows cab as updating")
    t0 = time.time(); hm.send_heartbeat()
    wait(lambda: local_loop() == other["id"], what="on-demand sync to override loop")
    ok(f"heartbeat triggered on-demand sync; new loop active on cab {time.time()-t0:.1f}s after heartbeat (not the 30 min poll)")
    hm.send_heartbeat(); c,_ = cab()
    assert c["status"] == "online" and c["playing"]["id"] == other["id"] and c["isUpToDate"], c
    ok("server reports cab now playing the override loop")

    r = admin.post(f"{API}/devices/{c['id']}/disable", json={"reason":"sim"}); assert r.ok, r.text
    hm.send_heartbeat()
    wait(lambda: (read_json(PLAYER_STATE_PATH, {}) or {}).get("disabled") is True, what="pause reaching player")
    ok("pause from the app reached the player via heartbeat-triggered sync")
    r = admin.post(f"{API}/devices/{c['id']}/enable"); assert r.ok, r.text
    hm.send_heartbeat()
    wait(lambda: (read_json(PLAYER_STATE_PATH, {}) or {}).get("disabled") is False, what="resume reaching player")
    ok("resume reached the player")

    r = admin.post(f"{API}/m/assign", json={"loopId": None, "target": {"type":"cab","deviceId": c["id"]}}); assert r.ok, r.text
    hm.send_heartbeat(); wait(lambda: local_loop() == fleet, what="back to fleet loop")
    ok("clearing the override returned the cab to the fleet loop")

    modem["gps"] = "nofix"; hm.gps.last_fix = None       # GPS lost and cache expired -> cell tower payload
    loc = hm.current_location(); assert loc["method"] == "cell_tower" and loc["cellId"] == 0x1A2B3C4 and loc["lac"] == 0x3039, loc
    hm.send_heartbeat(); ok(f"no GPS fix: firmware sent cell tower payload (cellId {loc['cellId']}, tac {loc['lac']}) and server accepted it")
    d = admin.get(f"{API}/m/cabs/{c['id']}").json()
    print("INFO cab detail: uptime", d["uptimeSeconds"], "onlineSince", d["onlineSince"], "firmware", d["firmwareVersion"], "signal", d["signalStrength"], "location", d["location"])
    print("ALL PASS")
finally:
    stop.set()
    time.sleep(0.5)
    device_id = (cab()[0] or {}).get("id")
    database = (os.environ.get("DATABASE_URL") or "").split("?")[0]
    if device_id and database:
        for sql in (f'DELETE FROM "PlaybackLog" WHERE "deviceId" = \'{device_id}\'', f'DELETE FROM "Device" WHERE id = \'{device_id}\''):
            subprocess.run(["psql", database, "-q", "-c", sql], check=False)
        print("removed the simulated cab", device_id)
    else:
        print("DEVICE_ID", device_id, "(left in the database: no DATABASE_URL)")
    shutil.rmtree(BASE, ignore_errors=True)
