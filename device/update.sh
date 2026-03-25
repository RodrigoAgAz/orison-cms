#!/bin/bash
set -euo pipefail

ARCHIVE_URL="${1:-}"
BASE_DIR="/opt/orison"
TMP_DIR="$(mktemp -d)"

if [[ -z "$ARCHIVE_URL" ]]; then
  echo "Usage: ./update.sh <TARBALL_URL>"
  exit 1
fi

curl -fsSL "$ARCHIVE_URL" -o "$TMP_DIR/orison-update.tar.gz"
tar -xzf "$TMP_DIR/orison-update.tar.gz" -C "$TMP_DIR"

sudo systemctl stop orison-health.service orison-player.service orison-sync.service
sudo cp -R "$TMP_DIR"/device/. "$BASE_DIR"/
sudo chown -R orison:orison "$BASE_DIR"
sudo systemctl start orison-sync.service orison-player.service orison-health.service

rm -rf "$TMP_DIR"
echo "Update applied"
