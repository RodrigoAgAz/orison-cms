#!/bin/bash
# Update the firmware on a cab, keeping a backup to roll back to.
#
# Usage:
#   sudo ./update.sh <release.tar.gz URL | release.tar.gz file | unpacked directory>
#   sudo ./update.sh --rollback        restore the firmware that was installed before the last update
#
# The release may be a tarball of the repository or of device/ alone. Only the service code,
# VERSION, the default still and the systemd units are installed (install.sh); config.json,
# content/, logs/ and runtime/ are never touched. If a service does not stay up after the update,
# the previous firmware is restored automatically.
set -euo pipefail

# The ORISON_* overrides exist for the script tests; a cab always uses the defaults.
BASE_DIR="${ORISON_BASE_DIR:-/opt/orison}"
UNIT_DIR="${ORISON_UNIT_DIR:-/etc/systemd/system}"
HEALTH_WAIT_SECONDS="${ORISON_HEALTH_WAIT_SECONDS:-30}"
RELEASES_DIR="$BASE_DIR/releases"
UNITS=(orison-sync.service orison-player.service orison-health.service)
KEEP_BACKUPS=3

if [[ $EUID -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

log() { echo "[orison-update] $*"; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

backup_installed() {
  local version stamp dest
  version="$(cat "$BASE_DIR/VERSION" 2>/dev/null || echo unknown)"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$RELEASES_DIR/$stamp-$version"
  mkdir -p "$dest/systemd"
  find "$BASE_DIR" -maxdepth 1 -type f \( -name '*.py' -o -name VERSION -o -name '*.jpg' \) -exec cp -p {} "$dest/" \;
  for unit in "${UNITS[@]}"; do
    [[ -f "$UNIT_DIR/$unit" ]] && cp -p "$UNIT_DIR/$unit" "$dest/systemd/"
  done
  # keep the newest few backups
  ls -1d "$RELEASES_DIR"/*/ 2>/dev/null | sort | head -n -"$KEEP_BACKUPS" | xargs -r rm -rf
  echo "$dest"
}

restore_backup() {
  local src="$1"
  log "restoring $(basename "$src")"
  systemctl stop "${UNITS[@]}" || true
  # remove modules the newer firmware added, then put the old files back
  for file in log_queue.py sd_notify.py netinfo.py; do
    [[ -f "$src/$file" ]] || rm -f "$BASE_DIR/$file"
  done
  find "$src" -maxdepth 1 -type f -exec cp -p {} "$BASE_DIR/" \;
  for unit in "${UNITS[@]}"; do
    [[ -f "$src/systemd/$unit" ]] && cp -p "$src/systemd/$unit" "$UNIT_DIR/$unit"
  done
  systemctl daemon-reload
  systemctl start --no-block "${UNITS[@]}"
  log "now running firmware $(cat "$BASE_DIR/VERSION" 2>/dev/null || echo unknown)"
}

services_healthy() {
  local unit before after
  declare -A restarts
  sleep "$HEALTH_WAIT_SECONDS"
  for unit in "${UNITS[@]}"; do
    systemctl is-active --quiet "$unit" || { log "$unit is not running"; return 1; }
    restarts[$unit]="$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)"
  done
  sleep "$((HEALTH_WAIT_SECONDS * 2 / 3))"
  for unit in "${UNITS[@]}"; do
    systemctl is-active --quiet "$unit" || { log "$unit stopped"; return 1; }
    after="$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)"
    before="${restarts[$unit]}"
    if [[ "$after" != "$before" ]]; then log "$unit is restarting repeatedly"; return 1; fi
  done
  return 0
}

if [[ "${1:-}" == "--rollback" ]]; then
  latest="$(ls -1d "$RELEASES_DIR"/*/ 2>/dev/null | sort | tail -n 1 || true)"
  [[ -n "$latest" ]] || { log "no backup in $RELEASES_DIR"; exit 1; }
  restore_backup "${latest%/}"
  rm -rf "${latest%/}"
  exit 0
fi

SOURCE="${1:-}"
if [[ -z "$SOURCE" ]]; then
  echo "Usage: sudo ./update.sh <release.tar.gz URL | file | directory>   or   sudo ./update.sh --rollback"
  exit 1
fi

# --- fetch and unpack ---------------------------------------------------------------------------
if [[ "$SOURCE" =~ ^https?:// ]]; then
  curl -fsSL --retry 3 "$SOURCE" -o "$TMP_DIR/release.tar.gz"
  mkdir "$TMP_DIR/release" && tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR/release"
  ROOT="$TMP_DIR/release"
elif [[ -f "$SOURCE" ]]; then
  mkdir "$TMP_DIR/release" && tar -xzf "$SOURCE" -C "$TMP_DIR/release"
  ROOT="$TMP_DIR/release"
elif [[ -d "$SOURCE" ]]; then
  ROOT="$(cd "$SOURCE" && pwd)"
else
  log "cannot read $SOURCE"; exit 1
fi

DEVICE_DIR=""
for candidate in "$ROOT" "$ROOT/device" "$ROOT"/*/device; do
  if [[ -f "$candidate/player_manager.py" && -f "$candidate/install.sh" ]]; then DEVICE_DIR="$candidate"; break; fi
done
[[ -n "$DEVICE_DIR" ]] || { log "no device/ directory with install.sh in $SOURCE"; exit 1; }

# --- validate before touching anything ------------------------------------------------------------
python3 - "$DEVICE_DIR" <<'PY'
import ast, pathlib, sys
root = pathlib.Path(sys.argv[1])
for path in root.glob("*.py"):
    ast.parse(path.read_text(encoding="utf-8"), str(path))
PY
bash -n "$DEVICE_DIR/install.sh"
NEW_VERSION="$(cat "$DEVICE_DIR/VERSION")"
log "updating $(cat "$BASE_DIR/VERSION" 2>/dev/null || echo unknown) -> $NEW_VERSION"

# --- back up, install, check ---------------------------------------------------------------------
BACKUP="$(backup_installed)"
log "backup of the installed firmware: $BACKUP"
# The services keep running (and the screen keeps playing) while packages and files are installed;
# each file is replaced atomically and only takes effect when the services restart below.
if ! ORISON_NO_RESTART=1 bash "$DEVICE_DIR/install.sh"; then
  log "install failed"
  restore_backup "$BACKUP"
  exit 1
fi
systemctl restart --no-block "${UNITS[@]}"

if [[ "${ORISON_SKIP_HEALTH_CHECK:-0}" == "1" ]]; then
  log "update applied (health check skipped)"
  exit 0
fi
log "waiting for the services to settle..."
if services_healthy; then
  log "update applied: firmware $NEW_VERSION is running"
else
  log "services unhealthy after the update; journal:"
  journalctl -u orison-player -u orison-sync -u orison-health -n 40 --no-pager || true
  restore_backup "$BACKUP"
  exit 1
fi
