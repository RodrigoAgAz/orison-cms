#!/usr/bin/env python3
"""On-disk queue for playback log entries, shared by the player (writer) and health monitor (sender).

Layout under LOG_DIR:
  playback.jsonl        the player appends here (one JSON object per line)
  outbox/<seq>.jsonl    segments of at most SEGMENT_ENTRIES entries waiting to be sent, oldest first
  playback.dead.jsonl   entries the server rejected (capped), for diagnosis only
  playback.lock         flock() lock serialising every change between the two processes

The health monitor rotates playback.jsonl into outbox segments under the lock, then sends one
segment at a time without holding the lock, so nothing the player appends during an upload can be
lost. Every entry the player writes carries an eventId so a resend after a lost response can be
de-duplicated (entries left by firmware before 1.2.0 have none; see normalize_legacy_entry).
"""

from __future__ import annotations

import json
import os
import re
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

try:
    import fcntl
except ImportError:  # pragma: no cover - not a supported platform for the services
    fcntl = None  # type: ignore[assignment]

from common import LOG_DIR, fsync_dir, read_jsonl, rewrite_jsonl, utc_now_iso

SEGMENT_ENTRIES = 200
DEAD_LETTER_MAX_ENTRIES = 1000

# What servers before contract 1.2.0 accept (packages/shared/src/schemas.ts). Entries are shaped to
# this before sending so that one odd value cannot get a whole batch rejected.
OLD_SERVER_MODES = {"journey", "silent", "idle"}
NEW_MODES = OLD_SERVER_MODES | {"continuous"}
PLAYER_STATES = {"IDLE", "SAFETY", "JOURNEY", "SILENT", "WIND_DOWN", "DISABLED"}
CONTENT_TYPES = {"ADVERTISEMENT", "FILLER"}
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def _normalize_iso(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if _ISO_RE.match(text):
        return text
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    from datetime import timezone

    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _short_str(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text[:limit] if text else None


def sanitize_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    """Shape an entry to what both old and new servers accept, or None if it cannot be sent at all."""
    played_at = _normalize_iso(entry.get("playedAt")) or _normalize_iso(entry.get("ts"))
    if played_at is None:
        return None
    out: dict[str, Any] = {}
    for key in ("eventId", "loopId"):
        if isinstance(entry.get(key), str) and entry[key]:
            out[key] = entry[key][:128]
    out["playedAt"] = played_at
    slot = entry.get("slotPosition")
    out["slotPosition"] = slot if isinstance(slot, int) and not isinstance(slot, bool) and 0 <= slot <= 9 else None
    content_type = entry.get("contentType")
    out["contentType"] = content_type if content_type in CONTENT_TYPES else None
    out["type"] = _short_str(entry.get("type"), 64)
    out["event"] = _short_str(entry.get("event"), 64)
    asset_id = entry.get("assetId")
    out["assetId"] = str(asset_id) if asset_id not in (None, "") else None
    mode = entry.get("mode")
    out["mode"] = mode if mode in NEW_MODES else None
    state = entry.get("state")
    out["state"] = state if state in PLAYER_STATES else None
    out["completedFull"] = bool(entry.get("completedFull", False))
    duration = entry.get("durationMs")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration >= 0:
        out["durationMs"] = int(duration)
    else:
        out["durationMs"] = None
    out["journeyId"] = _short_str(entry.get("journeyId"), 128)
    out["deviceSerial"] = _short_str(entry.get("deviceSerial"), 64)
    location = entry.get("location")
    out["location"] = location if isinstance(location, dict) else None
    return out


def downgrade_for_old_server(entries: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """Old servers reject mode 'continuous' (strict enum). Returns (entries, changed)."""
    changed = False
    result = []
    for entry in entries:
        if entry.get("mode") == "continuous":
            entry = {**entry, "mode": "journey"}
            changed = True
        result.append(entry)
    return result, changed


def normalize_legacy_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Entries written by firmware before 1.2.0 (still in playback.jsonl after an update) logged
    every still image shown while idle or muted as a completed ADVERTISEMENT play (attributed to
    the slot's video advert). Record those stills as what they were: a STATIC_IMAGE with no creative
    we can vouch for. Plays are otherwise left exactly as the old firmware recorded them.

    They deliberately get NO eventId: the server treats an eventId as the mark of a 1.2.0 entry
    whose durationMs and completedFull were measured (lib/playback-metrics.ts), and these were not
    (the old firmware logged every play as complete when it started). The cost is that this one
    leftover batch cannot be de-duplicated if its upload response is lost."""
    if entry.get("eventId"):
        return entry
    if (
        not entry.get("event")
        and entry.get("type") == "ADVERTISEMENT"
        and entry.get("mode") in ("idle", "silent")
    ):
        entry = {**entry, "type": "STATIC_IMAGE", "contentType": None, "assetId": None}
    return entry


class PlaybackLogQueue:
    def __init__(self, log_dir: Path = LOG_DIR, max_bytes: int = 50 * 1024 * 1024, logger=None) -> None:
        self.log_dir = log_dir
        self.path = log_dir / "playback.jsonl"
        self.outbox = log_dir / "outbox"
        self.dead_letter_path = log_dir / "playback.dead.jsonl"
        self.lock_path = log_dir / "playback.lock"
        self.status_path = log_dir / "playback.queue.json"
        self.max_bytes = max_bytes
        self.logger = logger
        self._appends_since_check = 0

    # --- locking -------------------------------------------------------------------------------
    @contextmanager
    def locked(self) -> Iterator[None]:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        with open(self.lock_path, "a+") as handle:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    # --- writer side (player) ------------------------------------------------------------------
    def append(self, entry: dict[str, Any], *, durable: bool = False) -> None:
        line = json.dumps(entry, separators=(",", ":")) + "\n"
        with self.locked():
            with open(self.path, "ab+") as handle:
                # A power cut can leave a half-written last line; start on a fresh line so the
                # next entry is not glued to it and lost as well.
                handle.seek(0, os.SEEK_END)
                if handle.tell() > 0:
                    handle.seek(-1, os.SEEK_END)
                    if handle.read(1) != b"\n":
                        handle.write(b"\n")
                handle.write(line.encode("utf-8"))
                handle.flush()
                if durable:
                    os.fsync(handle.fileno())
            self._appends_since_check += 1
            if self._appends_since_check >= 50:
                self._appends_since_check = 0
                if self._total_bytes() > self.max_bytes:
                    # The sender has not been running: rotate and trim here so the disk cannot fill.
                    self._rotate_locked()
                    self._enforce_cap_locked()

    def flush(self) -> None:
        """fsync appended entries (journey boundaries, end of a pass, shutdown)."""
        try:
            with open(self.path, "ab") as handle:
                os.fsync(handle.fileno())
        except OSError:
            pass

    # --- sender side (health monitor) ----------------------------------------------------------
    def rotate(self) -> None:
        with self.locked():
            self._rotate_locked()
            self._enforce_cap_locked()

    def segments(self) -> list[Path]:
        try:
            return sorted(p for p in self.outbox.iterdir() if p.suffix == ".jsonl")
        except OSError:
            return []

    def read_segment(self, segment: Path) -> list[dict[str, Any]]:
        return read_jsonl(segment)

    def remove_segment(self, segment: Path) -> None:
        with self.locked():
            segment.unlink(missing_ok=True)
            fsync_dir(self.outbox)

    def pending_count(self) -> int:
        count = 0
        for segment in self.segments():
            count += self._line_count(segment)
        count += self._line_count(self.path)
        return count

    def dead_letter(self, entries: list[dict[str, Any]], reason: str) -> None:
        if not entries:
            return
        with self.locked():
            stamp = utc_now_iso()
            existing = read_jsonl(self.dead_letter_path)
            existing.extend({"deadAt": stamp, "reason": reason[:300], "entry": e} for e in entries)
            rewrite_jsonl(self.dead_letter_path, existing[-DEAD_LETTER_MAX_ENTRIES:])
            self._bump_status("deadLettered", len(entries))

    def status(self) -> dict[str, Any]:
        data = self._read_status()
        return {
            "pending": self.pending_count(),
            "dropped": int(data.get("dropped", 0)),
            "deadLettered": int(data.get("deadLettered", 0)),
        }

    # --- internals -----------------------------------------------------------------------------
    def _line_count(self, path: Path) -> int:
        try:
            with open(path, "rb") as handle:
                return sum(1 for line in handle if line.strip())
        except OSError:
            return 0

    def _total_bytes(self) -> int:
        total = 0
        for path in [self.path, *self.segments()]:
            try:
                total += path.stat().st_size
            except OSError:
                pass
        return total

    def _next_segment_name(self) -> Path:
        base = int(time.time() * 1000)
        existing = {p.name for p in self.segments()}
        seq = 0
        while True:
            name = f"{base:015d}-{seq:04d}.jsonl"
            if name not in existing:
                return self.outbox / name
            seq += 1

    def _rotate_locked(self) -> None:
        items = read_jsonl(self.path)
        if not items:
            self.path.unlink(missing_ok=True)
            return
        self.outbox.mkdir(parents=True, exist_ok=True)
        items = [normalize_legacy_entry(item) for item in items]
        for start in range(0, len(items), SEGMENT_ENTRIES):
            rewrite_jsonl(self._next_segment_name(), items[start : start + SEGMENT_ENTRIES])
        self.path.unlink(missing_ok=True)
        fsync_dir(self.log_dir)

    def _enforce_cap_locked(self) -> None:
        dropped = 0
        segments = self.segments()
        while segments and self._total_bytes() > self.max_bytes:
            oldest = segments.pop(0)
            dropped += self._line_count(oldest)
            oldest.unlink(missing_ok=True)
        if dropped:
            self._bump_status("dropped", dropped)
            if self.logger:
                self.logger.warning(
                    "playback log queue over %s MB: dropped %s oldest unsent entries",
                    self.max_bytes // (1024 * 1024),
                    dropped,
                )

    def _read_status(self) -> dict[str, Any]:
        try:
            with open(self.status_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _bump_status(self, key: str, amount: int) -> None:
        data = self._read_status()
        data[key] = int(data.get(key, 0)) + amount
        data["updatedAt"] = utc_now_iso()
        tmp = self.status_path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, self.status_path)
        except OSError:
            pass
