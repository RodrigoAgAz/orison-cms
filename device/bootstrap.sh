#!/bin/bash
set -euo pipefail

SERIAL="${1:-}"
TOKEN="${2:-}"
BASE_DIR="/opt/orison"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$SERIAL" || -z "$TOKEN" ]]; then
  echo "Usage: ./bootstrap.sh <SERIAL_NUMBER> <API_TOKEN>"
  exit 1
fi

sudo useradd -r -s /usr/sbin/nologin orison || true
sudo mkdir -p "$BASE_DIR"/{content/{current,previous,staging,fallback},logs,runtime,systemd}
sudo chown -R orison:orison "$BASE_DIR"

sudo tee "$BASE_DIR/config.json" >/dev/null <<EOF
{
  "device": {
    "serialNumber": "${SERIAL}",
    "apiBaseUrl": "https://cms.orisonscreens.com/api",
    "apiToken": "${TOKEN}",
    "cdnBaseUrl": "https://cdn.orisonscreens.com"
  },
  "sync": {
    "checkIntervalSeconds": 1800,
    "maxDownloadRetries": 3,
    "downloadTimeoutSeconds": 300,
    "maxBandwidthBytesPerSec": 2000000
  },
  "playback": {
    "loopContinuously": true,
    "screenResolution": "1280x800",
    "fallbackContentPath": "/opt/orison/content/fallback/orison_fallback.mp4"
  },
  "health": {
    "heartbeatIntervalSeconds": 300,
    "logUploadIntervalSeconds": 3600,
    "maxLogRetentionDays": 30
  }
}
EOF

sudo chmod 600 "$BASE_DIR/config.json"
sudo python3 -m pip install requests psutil --break-system-packages

sudo cp "$SCRIPT_DIR"/*.py "$BASE_DIR/"
sudo cp "$SCRIPT_DIR"/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orison-sync.service orison-player.service orison-health.service

echo "Bootstrap complete. Copy fallback media to $BASE_DIR/content/fallback/orison_fallback.mp4 and reboot."
