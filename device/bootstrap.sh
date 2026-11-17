#!/bin/bash
# First-time setup of a cab: writes /opt/orison/config.json (only if it does not exist yet),
# then installs packages, the service user, the code and the systemd services (install.sh).
# Works on Debian/Ubuntu (x86) and Raspberry Pi OS. Safe to re-run.
#
# Usage: sudo ./bootstrap.sh <SERIAL_NUMBER> <API_TOKEN> <API_BASE_URL>
#   API_BASE_URL is the CMS's address followed by /api, e.g. https://<your CMS host>/api. It is
#   needed only when there is no config.json yet (there is no default: a guessed address leaves a
#   new cab polling a host that is not the CMS).
set -euo pipefail

SERIAL="${1:-}"
TOKEN="${2:-}"
API_BASE_URL="${3:-}"
BASE_DIR="${ORISON_BASE_DIR:-/opt/orison}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$SERIAL" || -z "$TOKEN" ]]; then
  echo "Usage: sudo ./bootstrap.sh <SERIAL_NUMBER> <API_TOKEN> <API_BASE_URL>"
  exit 1
fi
if [[ -z "$API_BASE_URL" && ! -f "$BASE_DIR/config.json" ]]; then
  echo "Usage: sudo ./bootstrap.sh <SERIAL_NUMBER> <API_TOKEN> <API_BASE_URL>   (e.g. https://<your CMS host>/api)"
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

ORISON_NO_RESTART=1 bash "$SCRIPT_DIR/install.sh"

if [[ -f "$BASE_DIR/config.json" ]]; then
  echo "[orison-bootstrap] keeping the existing $BASE_DIR/config.json (serial $(python3 -c 'import json;import sys;print(json.load(open(sys.argv[1]))["device"]["serialNumber"])' "$BASE_DIR/config.json" 2>/dev/null || echo '?'))"
else
  SERIAL="$SERIAL" TOKEN="$TOKEN" API_BASE_URL="$API_BASE_URL" python3 - "$BASE_DIR/config.json" <<'PY'
import json, os, sys
config = {
    "device": {
        "serialNumber": os.environ["SERIAL"],
        "apiBaseUrl": os.environ["API_BASE_URL"],
        "apiToken": os.environ["TOKEN"],
    },
    "playback": {"trigger": "auto"},
}
tmp = sys.argv[1] + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, sys.argv[1])
PY
  chown "${ORISON_SERVICE_USER:-orison}:${ORISON_SERVICE_USER:-orison}" "$BASE_DIR/config.json"
  echo "[orison-bootstrap] wrote $BASE_DIR/config.json for $SERIAL"
fi

systemctl restart --no-block orison-sync.service orison-player.service orison-health.service
echo "[orison-bootstrap] done. Optional: put a fallback video at $BASE_DIR/content/fallback/orison_fallback.mp4."
echo "[orison-bootstrap] check with: systemctl status 'orison-*'  and  journalctl -u orison-player -f"
