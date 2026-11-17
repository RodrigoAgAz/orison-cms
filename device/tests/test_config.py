"""config.json: the template documents the real defaults, and old files keep working (finding 23)."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support  # noqa: E402

from common import DeviceConfig  # noqa: E402

PROPERTIES = [
    "sync_interval_seconds", "max_download_retries", "download_timeout_seconds", "max_bandwidth_bytes_per_sec",
    "min_free_space_mb", "cache_max_mb", "playback_trigger", "always_safety_every_cycles", "display",
    "gps_enabled", "at_port", "heartbeat_interval_seconds", "max_log_queue_bytes",
]


class TestConfig(unittest.TestCase):
    def test_template_equals_defaults(self):
        template = DeviceConfig(json.loads((support.DEVICE_DIR / "config.json.template").read_text()))
        defaults = DeviceConfig({"device": {}})
        for name in PROPERTIES:
            self.assertEqual(getattr(template, name), getattr(defaults, name), name)
        self.assertEqual(str(template.fallback_content_path), "/opt/orison/content/fallback/orison_fallback.mp4")

    def test_every_template_key_is_read(self):
        source = "".join((support.DEVICE_DIR / name).read_text() for name in ("common.py",))
        template = json.loads((support.DEVICE_DIR / "config.json.template").read_text())

        def keys(node, prefix=""):
            for key, value in node.items():
                if isinstance(value, dict):
                    yield from keys(value, prefix + key + ".")
                else:
                    yield prefix + key, key
        for full, key in keys(template):
            if full.startswith("device."):
                continue
            self.assertIn(f'"{key}"', source, f"{full} is in the template but nothing reads it")

    def test_old_firmware_config_still_works(self):
        old = {
            "device": {"serialNumber": "S", "apiBaseUrl": "https://x/api/", "apiToken": "t", "cdnBaseUrl": "https://cdn"},
            "sync": {"checkIntervalSeconds": 1800, "maxDownloadRetries": 3, "downloadTimeoutSeconds": 300, "maxBandwidthBytesPerSec": 2000000},
            "playback": {"loopContinuously": True, "screenResolution": "1280x800", "fallbackContentPath": "/opt/orison/content/fallback/orison_fallback.mp4"},
            "location": {"gpsEnabled": True},
            "health": {"heartbeatIntervalSeconds": 300, "logUploadIntervalSeconds": 3600, "maxLogRetentionDays": 30},
        }
        config = DeviceConfig(old)
        self.assertEqual(config.api_base_url, "https://x/api")
        self.assertEqual(config.playback_trigger, "auto")
        self.assertEqual(config.display["keepAspect"], True)
        self.assertEqual(config.heartbeat_interval_seconds, 300)
        self.assertEqual(str(config.fallback_content_path), "/opt/orison/content/fallback/orison_fallback.mp4")

    def test_bad_values_fall_back_to_defaults(self):
        config = DeviceConfig({"sync": {"checkIntervalSeconds": "soon", "maxBandwidthBytesPerSec": -1},
                               "playback": {"display": "hdmi", "alwaysSafetyEveryCycles": 0}, "health": None})
        self.assertEqual(config.sync_interval_seconds, 1800)
        self.assertEqual(config.max_bandwidth_bytes_per_sec, 0)
        self.assertEqual(config.display["videoOutput"], "auto")
        self.assertEqual(config.always_safety_every_cycles, 1)
        self.assertEqual(config.heartbeat_interval_seconds, 300)


if __name__ == "__main__":
    unittest.main()
