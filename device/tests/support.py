"""Shared test support: an isolated ORISON_BASE_DIR, a fake clock and a fake mpv.

The fake mpv serves mpv's JSON IPC protocol on a UNIX socket (loadfile, set_property, seek,
get_property path/time-pos/eof-reached/duration) and derives time-pos from the fake clock, so the
real PlayerManager can be driven through hours of playback in milliseconds.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path

DEVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(DEVICE_DIR))
if "ORISON_BASE_DIR" not in os.environ:
    os.environ["ORISON_BASE_DIR"] = tempfile.mkdtemp(prefix="orison-test-")
    import atexit

    atexit.register(shutil.rmtree, os.environ["ORISON_BASE_DIR"], True)
sys.dont_write_bytecode = True

import common  # noqa: E402

logging.disable(logging.CRITICAL)  # the services log to stderr; keep test output readable

BASE = common.BASE_DIR
CONFIG = {
    "device": {"serialNumber": "TEST-CAB-01", "apiBaseUrl": "http://127.0.0.1:9/api", "apiToken": "t"},
    "sync": {"checkIntervalSeconds": 1800, "maxDownloadRetries": 2, "downloadTimeoutSeconds": 10, "maxBandwidthBytesPerSec": 0},
    "playback": {"fallbackContentPath": str(BASE / "fallback.mp4")},
    "health": {"heartbeatIntervalSeconds": 300},
}


def reset_base_dir(config: dict | None = None) -> None:
    """Wipe everything under the shared test base dir and write a fresh config.json."""
    BASE.mkdir(parents=True, exist_ok=True)
    for child in BASE.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child, ignore_errors=True)
        else:
            child.unlink(missing_ok=True)
    (BASE / "config.json").write_text(json.dumps(config or CONFIG))
    common.ensure_directories()


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def monotonic(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += max(seconds, 0)

    def time(self) -> float:
        return 1.7e9 + self.t


def make_time_shim(clock: FakeClock):
    class TimeShim:
        monotonic = staticmethod(clock.monotonic)
        sleep = staticmethod(clock.sleep)
        time = staticmethod(clock.time)

    return TimeShim


class FakeMpv:
    """One fake mpv 'process' (Popen interface) serving the IPC socket.

    Every reply is preceded by an event line, as real mpv may interleave events, to check that the
    player skips them. Firmware 1.0.0 cannot (it reads one recv() as one JSON document), so the
    billing end-to-end script turns that off (send_events = False) when it runs the old player."""

    send_events = True

    def __init__(self, sock_path: str, media: str, loop_forever: bool, durations: dict, clock: FakeClock, command: list):
        self.sock_path = sock_path
        self.durations = durations
        self.clock = clock
        self.command = command
        self.returncode = None
        self.path = media
        self.loop = loop_forever
        self.loaded_at = clock.t
        self.seek_base = 0.0
        self.commands: list = []
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(sock_path)
        self.srv.listen(16)
        self.alive = True
        threading.Thread(target=self.serve, daemon=True).start()

    def _duration(self):
        return self.durations.get(Path(self.path).name)

    def time_pos(self):
        d = self._duration()
        if d is None:
            return None
        pos = self.seek_base + (self.clock.t - self.loaded_at)
        return pos % d if self.loop else min(pos, d)

    def eof(self):
        d = self._duration()
        if d is None or self.loop:
            return False
        return self.seek_base + (self.clock.t - self.loaded_at) >= d

    def serve(self):
        while self.alive:
            try:
                conn, _ = self.srv.accept()
            except OSError:
                return
            with conn:
                try:
                    data = conn.recv(65536)
                except OSError:
                    continue
                if not data:
                    continue
                msg = json.loads(data.decode().splitlines()[0])
                cmd = msg["command"]
                self.commands.append(cmd)
                resp = {"error": "success", "data": None}
                if cmd[0] == "loadfile":
                    self.path = cmd[1]
                    self.loaded_at = self.clock.t
                    self.seek_base = 0.0
                elif cmd[0] == "set_property" and cmd[1] == "loop-file":
                    self.loop = cmd[2] == "inf"
                elif cmd[0] == "seek":
                    self.seek_base = float(cmd[1])
                    self.loaded_at = self.clock.t
                elif cmd[0] == "get_property":
                    name = cmd[1]
                    if name == "path":
                        resp["data"] = self.path
                    elif name == "time-pos":
                        tp = self.time_pos()
                        resp = {"error": "property unavailable"} if tp is None else {"error": "success", "data": tp}
                    elif name == "eof-reached":
                        resp["data"] = self.eof()
                    elif name == "duration":
                        d = self._duration()
                        resp = {"error": "property unavailable"} if d is None else {"error": "success", "data": d}
                # mpv broadcasts events to every client; make sure the player skips them.
                event = json.dumps({"event": "property-change", "name": "x"}) + "\n" if self.send_events else ""
                try:
                    conn.sendall((event + json.dumps(resp) + "\n").encode())
                except OSError:
                    pass

    def loadfile_count(self) -> int:
        return sum(1 for c in self.commands if c[0] == "loadfile")

    # Popen interface
    def poll(self):
        return self.returncode

    def terminate(self):
        self.kill()

    def kill(self):
        self.alive = False
        if self.returncode is None:
            self.returncode = -15
        try:
            self.srv.close()
        except OSError:
            pass

    def wait(self, timeout=None):
        return self.returncode

    def die(self, code: int = 1):
        """Simulate a crash: the process exits, the socket file is left on disk."""
        self.alive = False
        self.returncode = code
        try:
            self.srv.close()
        except OSError:
            pass


class MpvFactory:
    def __init__(self, sock_path: str, clock: FakeClock, durations: dict):
        self.sock_path = sock_path
        self.clock = clock
        self.durations = durations
        self.instances: list[FakeMpv] = []
        self.fail_to_start = False

    def popen(self, command, *args, **kwargs):
        if self.fail_to_start:
            raise FileNotFoundError("mpv")
        media = command[-1]
        loop = "--loop-file=inf" in command
        mpv = FakeMpv(self.sock_path, media, loop, self.durations, self.clock, command)
        self.instances.append(mpv)
        return mpv

    @property
    def current(self) -> FakeMpv:
        return self.instances[-1]

    def stop_all(self):
        for mpv in self.instances:
            mpv.kill()
