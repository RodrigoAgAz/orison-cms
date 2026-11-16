#!/usr/bin/env python3
"""On-demand sync signalling between orison-health and orison-sync (separate processes).

health_monitor drops RUNTIME_DIR/sync_request.json; sync_agent consumes (deletes) it.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Callable

from common import RUNTIME_DIR, atomic_write_json, utc_now_iso

SYNC_REQUEST_PATH = RUNTIME_DIR / "sync_request.json"
MIN_REQUEST_INTERVAL_SECONDS = 120.0


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def decide_sync_reasons(
    response: Any,
    local_loop_id: str | None,
    local_checksum: str | None,
    local_disabled: bool | None,
) -> list[str]:
    """Which server expectations disagree with the device? Missing fields mean "no opinion"."""
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
