"""End-to-end simulation of one cab against a running local CMS.

Runs the real firmware services from device/ (health monitor and sync agent) in a temporary
ORISON_BASE_DIR with a fake modem and a fake player, and drives the CMS through the mobile API
the way the phone app does. It checks that a heartbeat registers the cab with a GPS position,
that content is downloaded and verified, that an override, a pause and a resume made from the
app reach the cab on its next heartbeat, and that the cell-tower fallback is accepted.

Needs: the web app running (DEMO_BASE_URL, default http://localhost:3000), a published fleet
loop plus one other published loop (npm run demo:seed), ffmpeg, and python3 with requests and
psutil. Run: python3 scripts/demo/simulate-cab.py
The simulated cab (serial SIM-CAB-E2E) is left in the database; delete it from the Devices page.
"""
import json, os, sys, threading, time, tempfile, subprocess, shutil
from pathlib import Path

BASE = Path(tempfile.mkdtemp(prefix="orison-sim-"))
os.environ["ORISON_BASE_DIR"] = str(BASE)
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "device"))
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
  "playback":{"loopContinuously":True,"screenResolution":"1280x800","fallbackContentPath":str(fallback)},
  "health":{"heartbeatIntervalSeconds":300,"logUploadIntervalSeconds":3600,"maxLogRetentionDays":30}}))

import common, health_monitor, sync_agent
from common import PLAYER_COMMAND_PATH, PLAYER_STATE_PATH, current_manifest_path, read_json, atomic_write_json, utc_now_iso

# ---- fake player: honours reload / set_disabled exactly like player_manager.handle_commands reports it
stop = threading.Event()
def fake_player():
    disabled = False
    while not stop.is_set():
        try:
            cmd = read_json(PLAYER_COMMAND_PATH)
        except Exception:
            cmd = None
        if cmd:
            if cmd.get("action") in ("reload","set_disabled"):
                disabled = bool(cmd.get("disabled"))
            PLAYER_COMMAND_PATH.unlink(missing_ok=True)
            atomic_write_json(PLAYER_STATE_PATH, {
                "status": "disabled" if disabled else "idle", "disabled": disabled,
                "loopId": read_json(current_manifest_path(), {}).get("loopId"),
                "lastHandledAction": cmd.get("action"),
                "lastHandledCommandId": str(cmd.get("commandId") or cmd.get("ts")),
                "lastHandledLoopId": cmd.get("loopId"), "lastHandledOk": True, "updatedAt": utc_now_iso()})
        time.sleep(0.2)
threading.Thread(target=fake_player, daemon=True).start()

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
    hm.send_heartbeat(); c,_ = cab()
    assert c["status"] == "online" and c["isUpToDate"] and c["playing"]["id"] == fleet, c
    assert not (common.RUNTIME_DIR/"sync_request.json").exists()
    ok("server reports cab online and up to date; no sync requested")

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
    print("DEVICE_ID", (cab()[0] or {}).get("id"))
    shutil.rmtree(BASE, ignore_errors=True)
