#!/usr/bin/env python3
"""On-demand signalling between orison-health and orison-sync (separate processes).

health_monitor drops RUNTIME_DIR/sync_request.json; sync_agent consumes (deletes) it.
sync_agent drops RUNTIME_DIR/heartbeat_request.json after activating content; health_monitor
consumes it and sends a full heartbeat straight away.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable

from common import RUNTIME_DIR, atomic_write_json, utc_now_iso

SYNC_REQUEST_PATH = RUNTIME_DIR / "sync_request.json"
HEARTBEAT_REQUEST_PATH = RUNTIME_DIR / "heartbeat_request.json"
MIN_REQUEST_INTERVAL_SECONDS = 120.0
_UNSET = object()


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def decide_sync_reasons(
    response: Any,
    local_loop_id: str | None,
    local_checksum: str | None,
    local_disabled: bool | None,
    local_safety_checksum: object = _UNSET,
) -> list[str]:
    """Which server expectations disagree with the device? Missing fields mean "no opinion".

    `expectedSafetyChecksum` is different: the key being absent means no opinion (old server),
    while null means the cab should have no safety message at all.
    """
    if not isinstance(response, dict):
        return []
    reasons: list[str] = []
    expected_loop = _text(response.get("expectedLoopId"))
    expected_checksum = _text(response.get("expectedChecksum"))
    if expected_loop is not None and expected_loop != local_loop_id:
        reasons.append("loopId")
    if expected_checksum is not None and expected_checksum != local_checksum:
        reasons.append("checksum")
    expected_disabled = response.get("disabled")
    if isinstance(expected_disabled, bool) and isinstance(local_disabled, bool) and expected_disabled != local_disabled:
        reasons.append("disabled")
    if local_safety_checksum is not _UNSET and "expectedSafetyChecksum" in response:
        expected_safety = response.get("expectedSafetyChecksum")
        if expected_safety is None or isinstance(expected_safety, str):
            if (expected_safety or None) != (local_safety_checksum or None):
                reasons.append("safety")
    return reasons


class SyncRequester:
    def __init__(
        self,
        path: Path = SYNC_REQUEST_PATH,
        min_interval_s: float = MIN_REQUEST_INTERVAL_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.path = path
        self.min_interval_s = min_interval_s
        self.monotonic = monotonic
        self.last_request_at: float | None = None

    def maybe_request(self, reasons: list[str], expected: dict | None = None) -> bool:
        """Write the request file if reasons exist and the rate limit allows. Returns True if written."""
        if not reasons:
            return False
        now = self.monotonic()
        if self.last_request_at is not None and now - self.last_request_at < self.min_interval_s:
            return False
        if self.path.exists():
            return False  # already pending; sync agent has not picked it up yet
        atomic_write_json(self.path, {"requestedAt": utc_now_iso(), "reasons": reasons, "expected": expected or {}})
        self.last_request_at = now
        return True


def consume_sync_request(path: Path = SYNC_REQUEST_PATH) -> dict | None:
    """Return the pending request (possibly {} if unreadable) and delete it, or None if none."""
    try:
        with path.open("r", encoding="utf-8") as handle:
            try:
                data = json.load(handle)
            except ValueError:
                data = {}
    except FileNotFoundError:
        return None
    except OSError:
        data = {}
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        return None
    return data if isinstance(data, dict) else {}


def request_heartbeat(reason: str, path: Path = HEARTBEAT_REQUEST_PATH) -> None:
    """Ask the health monitor for an immediate full heartbeat (e.g. right after a loop switch)."""
    try:
        atomic_write_json(path, {"requestedAt": utc_now_iso(), "reason": reason}, durable=False)
    except OSError:
        pass


def consume_heartbeat_request(path: Path = HEARTBEAT_REQUEST_PATH) -> dict | None:
    return consume_sync_request(path)
