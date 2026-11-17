"""bootstrap.sh / install.sh / update.sh in a temporary root, with systemctl and apt stubbed.

Checks the things that would break a working cab: config.json never touched, only runtime files
installed, content and logs left alone, units reloaded, re-runnable, rollback restores the old
firmware (finding 17). Needs bash and root (for chown); skipped otherwise.
"""

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402

DEVICE = support.DEVICE_DIR

STUB = """#!/bin/bash
echo "$(basename "$0") $*" >> "$STUB_LOG"
case "$(basename "$0") $1" in
  "systemctl is-active") exit "${STUB_ACTIVE:-0}" ;;
  "systemctl show") echo 0 ;;
  "dpkg-query -W") echo "install ok installed" ;;
  "apt-cache show") exit 1 ;;
esac
exit 0
"""

OLD_CONFIG = {
    "device": {"serialNumber": "REAL-CAB-1", "apiBaseUrl": "https://cms.example/api", "apiToken": "secret", "cdnBaseUrl": "https://cdn"},
    "sync": {"checkIntervalSeconds": 1800, "maxDownloadRetries": 3, "downloadTimeoutSeconds": 300, "maxBandwidthBytesPerSec": 2000000},
    "playback": {"loopContinuously": True, "screenResolution": "1280x800", "fallbackContentPath": "/opt/orison/content/fallback/orison_fallback.mp4"},
    "location": {"gpsEnabled": True},
    "health": {"heartbeatIntervalSeconds": 300, "logUploadIntervalSeconds": 3600, "maxLogRetentionDays": 30},
}


@unittest.skipUnless(shutil.which("bash") and hasattr(os, "geteuid") and os.geteuid() == 0, "needs bash and root")
class TestScripts(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="orison-scripts-"))
        self.base = self.root / "opt-orison"
        self.units = self.root / "units"
        self.units.mkdir()
        stubs = self.root / "stubs"
        stubs.mkdir()
        for name in ("systemctl", "apt-get", "dpkg-query", "apt-cache", "useradd", "usermod", "journalctl", "sudo"):
            (stubs / name).write_text(STUB)
            (stubs / name).chmod(0o755)
        self.log = self.root / "stub.log"
        self.env = {
            **os.environ,
            "PATH": f"{stubs}:{os.environ['PATH']}",
            "STUB_LOG": str(self.log),
            "ORISON_BASE_DIR": str(self.base),
            "ORISON_UNIT_DIR": str(self.units),
            "ORISON_SERVICE_USER": "root",
            "ORISON_HEALTH_WAIT_SECONDS": "0",
        }
        # a release laid out like a repository checkout, including things that must not be installed
        self.release = self.root / "orison-cms-abc123" / "device"
        shutil.copytree(DEVICE, self.release, ignore=shutil.ignore_patterns("__pycache__", "demo_content"))
        (self.release / "config.json").write_text(json.dumps({"device": {"serialNumber": "ORISON-TEST-001"}}))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_script(self, *args, check=True, **env):
        result = subprocess.run(["bash", *args], env={**self.env, **env}, capture_output=True, text=True, timeout=120)
        if check and result.returncode != 0:
            self.fail(f"{args} failed ({result.returncode}):\n{result.stdout}\n{result.stderr}")
        return result

    def make_old_install(self):
        """What a 1.0.0 cab looks like after the old bootstrap.sh / update.sh."""
        self.base.mkdir(parents=True)
        (self.base / "config.json").write_text(json.dumps(OLD_CONFIG, indent=2))
        for name in ("common.py", "player_manager.py", "sync_agent.py", "health_monitor.py", "modem.py", "sync_signal.py", "demo.py"):
            (self.base / name).write_text("# firmware 1.0.0\n")
        (self.base / "VERSION").write_text("1.0.0\n")
        (self.base / "tests").mkdir()
        (self.base / "tests" / "test_modem.py").write_text("")
        current = self.base / "content" / "current"
        current.mkdir(parents=True)
        (current / "loop.mp4").write_bytes(b"video")
        (current / "manifest.json").write_text('{"loopId":"L1"}')
        (self.base / "logs").mkdir()
        (self.base / "logs" / "playback.jsonl").write_text('{"type":"ADVERTISEMENT"}\n')
        for unit in ("orison-sync.service", "orison-player.service", "orison-health.service"):
            (self.units / unit).write_text("[Service]\nType=simple\n# 1.0.0\n")

    def test_update_from_old_firmware_and_roll_back(self):
        self.make_old_install()
        config_before = (self.base / "config.json").read_bytes()
        archive = self.root / "release.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(self.release.parent, arcname="orison-cms-abc123")

        self.run_script(str(self.release / "update.sh"), str(archive))
        self.assertEqual((self.base / "config.json").read_bytes(), config_before)
        self.assertEqual((self.base / "VERSION").read_text().strip(), "1.2.0")
        for name in ("log_queue.py", "sd_notify.py", "netinfo.py", "orison_static_fallback.jpg", "update.sh", "install.sh"):
            self.assertTrue((self.base / name).exists(), name)
        for name in ("tests", "demo.py"):
            self.assertFalse((self.base / name).exists(), name)
        self.assertEqual((self.base / "content" / "current" / "loop.mp4").read_bytes(), b"video")
        self.assertTrue((self.base / "logs" / "playback.jsonl").exists())
        self.assertIn("Type=notify", (self.units / "orison-player.service").read_text())
        calls = self.log.read_text()
        self.assertIn("systemctl daemon-reload", calls)
        self.assertIn("systemctl restart", calls)
        self.assertEqual(len(list((self.base / "releases").iterdir())), 1)

        self.run_script(str(self.base / "update.sh"), "--rollback")
        self.assertEqual((self.base / "VERSION").read_text().strip(), "1.0.0")
        self.assertEqual((self.base / "player_manager.py").read_text(), "# firmware 1.0.0\n")
        self.assertFalse((self.base / "log_queue.py").exists())
        self.assertIn("# 1.0.0", (self.units / "orison-player.service").read_text())
        self.assertEqual((self.base / "config.json").read_bytes(), config_before)
        self.assertTrue((self.base / "update.sh").exists())  # can roll forward again

    def test_unhealthy_update_rolls_back_automatically(self):
        self.make_old_install()
        result = self.run_script(str(self.release / "update.sh"), str(self.release.parent), check=False, STUB_ACTIVE="3")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.base / "VERSION").read_text().strip(), "1.0.0")

    def test_broken_release_changes_nothing(self):
        self.make_old_install()
        (self.release / "sync_agent.py").write_text("def broken(:\n")
        result = self.run_script(str(self.release / "update.sh"), str(self.release), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.base / "VERSION").read_text().strip(), "1.0.0")

    def test_bootstrap_fresh_then_rerun_keeps_config(self):
        self.run_script(str(self.release / "bootstrap.sh"), "NEW-CAB-7", "tok", "https://cms.example/api")
        config = json.loads((self.base / "config.json").read_text())
        self.assertEqual(config["device"]["serialNumber"], "NEW-CAB-7")
        self.assertEqual(oct((self.base / "config.json").stat().st_mode & 0o777), "0o600")
        for sub in ("content/current", "content/cache", "logs", "runtime"):
            self.assertTrue((self.base / sub).is_dir(), sub)
        self.assertTrue((self.base / "orison_static_fallback.jpg").exists())
        before = (self.base / "config.json").read_bytes()
        self.run_script(str(self.release / "bootstrap.sh"), "OTHER-SERIAL", "tok2")
        self.run_script(str(self.release / "install.sh"))
        self.assertEqual((self.base / "config.json").read_bytes(), before)
        self.assertIn("dpkg-query -W -f=${Status} mpv", self.log.read_text())  # packages checked every run
        self.assertNotIn("apt-get install", self.log.read_text())  # and only installed when missing

    def test_scripts_parse(self):
        for script in ("install.sh", "bootstrap.sh", "update.sh"):
            subprocess.run(["bash", "-n", str(DEVICE / script)], check=True)


if __name__ == "__main__":
    unittest.main()
