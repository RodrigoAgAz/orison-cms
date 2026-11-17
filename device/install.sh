#!/bin/bash
# Install (or re-install) the Orison cab services from the directory this script is in.
#
# Safe to re-run. Never touches /opt/orison/config.json, content/, logs/ or runtime/.
# Used by bootstrap.sh (first install) and update.sh (updates); not normally run by hand.
#
# Environment:
#   ORISON_NO_RESTART=1   install everything but do not (re)start the services
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The ORISON_* overrides exist for the script tests; a cab always uses the defaults.
BASE_DIR="${ORISON_BASE_DIR:-/opt/orison}"
SERVICE_USER="${ORISON_SERVICE_USER:-orison}"
UNIT_DIR="${ORISON_UNIT_DIR:-/etc/systemd/system}"
UNITS=(orison-sync.service orison-player.service orison-health.service)
# Only what runs on the cab: never tests, the desktop demo, or a stray config.json.
CODE_FILES=(
  common.py player_manager.py sync_agent.py health_monitor.py modem.py sync_signal.py
  log_queue.py sd_notify.py netinfo.py VERSION orison_static_fallback.jpg
  install.sh update.sh README.md
)

if [[ $EUID -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

log() { echo "[orison-install] $*"; }

for file in "${CODE_FILES[@]}" "${UNITS[@]/#/systemd/}"; do
  [[ -f "$SRC/$file" ]] || { log "missing $SRC/$file: incomplete release, nothing changed"; exit 1; }
done

# --- 1. packages ------------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  wanted=(python3 python3-requests python3-psutil mpv)
  model="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || true)"
  if [[ "$model" == *"Raspberry Pi"* ]]; then
    # GPIO inputs (passenger button, door sensor, driver override) on a Raspberry Pi.
    if [[ "$model" == *"Raspberry Pi 5"* ]] && apt-cache show python3-rpi-lgpio >/dev/null 2>&1; then
      wanted+=(python3-rpi-lgpio)
    elif apt-cache show python3-rpi.gpio >/dev/null 2>&1; then
      wanted+=(python3-rpi.gpio)
    fi
  fi
  missing=()
  for pkg in "${wanted[@]}"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" || missing+=("$pkg")
  done
  if ((${#missing[@]})); then
    log "installing packages: ${missing[*]}"
    apt-get update -qq || log "apt-get update failed; trying the install anyway"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${missing[@]}"
  fi
else
  log "apt-get not found: install python3 with requests and psutil, and mpv, yourself"
fi
if ! python3 -c 'import requests, psutil' 2>/dev/null; then
  log "python3 cannot import requests and psutil; trying pip"
  python3 -m pip install requests psutil --break-system-packages 2>/dev/null || python3 -m pip install requests psutil
fi
command -v mpv >/dev/null 2>&1 || log "WARNING: mpv is not installed; the screen will stay blank"

# --- 2. service user and the groups mpv and the modem need -------------------------------------
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$BASE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
# video/render: the display (DRM) and GPU decoding; audio: sound; dialout: the modem's AT port;
# gpio/input: buttons on boards that have them. Only groups that exist on this system are added.
for group in video render audio dialout gpio input; do
  if getent group "$group" >/dev/null; then
    usermod -aG "$group" "$SERVICE_USER"
  fi
done

# --- 3. directories ------------------------------------------------------------------------------
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$BASE_DIR"
for dir in content content/current content/previous content/staging content/fallback content/cache logs runtime; do
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$BASE_DIR/$dir"
done

# --- 4. code (each file replaced atomically) -------------------------------------------------------
for file in "${CODE_FILES[@]}"; do
  mode=0644
  [[ "$file" == *.sh ]] && mode=0755
  install -m "$mode" -o root -g root "$SRC/$file" "$BASE_DIR/.$file.new"
  mv -f "$BASE_DIR/.$file.new" "$BASE_DIR/$file"
done
# Left behind by the old update.sh, which copied the whole device/ directory.
rm -rf "$BASE_DIR/tests" "$BASE_DIR/demo.py" "$BASE_DIR/demo_content" "$BASE_DIR/__pycache__" "$BASE_DIR/config.json.template"

# --- 5. systemd ------------------------------------------------------------------------------------
for unit in "${UNITS[@]}"; do
  install -m 0644 -o root -g root "$SRC/systemd/$unit" "$UNIT_DIR/$unit"
done
systemctl daemon-reload
systemctl enable "${UNITS[@]}" >/dev/null

if [[ ! -f "$BASE_DIR/config.json" ]]; then
  [[ "${ORISON_NO_RESTART:-0}" == "1" ]] || log "no $BASE_DIR/config.json yet: run bootstrap.sh <SERIAL> <TOKEN> to create it"
  exit 0
fi
if [[ ! -s "$BASE_DIR/content/fallback/orison_fallback.mp4" ]]; then
  log "note: no fallback video at $BASE_DIR/content/fallback/orison_fallback.mp4; until the first sync the screen shows the default still"
fi

if [[ "${ORISON_NO_RESTART:-0}" != "1" ]]; then
  systemctl restart --no-block "${UNITS[@]}"
  log "services restarted"
fi
log "installed firmware $(cat "$BASE_DIR/VERSION")"
