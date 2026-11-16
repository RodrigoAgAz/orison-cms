#!/usr/bin/env python3
"""Quectel modem helpers: serving-cell parsing and GNSS (GPS) reading.

Pure Python with no third-party imports, so it can be unit-tested anywhere.
Serial I/O is injected: ``GpsReader`` takes an ``at(command, timeout_s) -> str`` callable.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Callable

# ---------------------------------------------------------------------------
# Serving cell parsing
# ---------------------------------------------------------------------------

# Positional field indexes AFTER the leading '+QENG:' (0 = "servingcell", 1 = state, 2 = radio).
#   LTE   : is_tdd,MCC,MNC,cellID(hex),PCID,earfcn,band,UL_bw,DL_bw,TAC(hex),RSRP,RSRQ,RSSI,SINR,srxlev
#   WCDMA : MCC,MNC,LAC(hex),cellID(hex),uarfcn,PSC,RAC,RSCP,ecio,...
#   GSM   : MCC,MNC,LAC(hex),cellID(hex),BSIC,ARFCN,band,RxLev,...
_LAYOUTS = {
    "LTE": {"mcc": 4, "mnc": 5, "cellId": 6, "lac": 12, "signal": 13},
    "WCDMA": {"mcc": 3, "mnc": 4, "lac": 5, "cellId": 6, "signal": 10},
    "GSM": {"mcc": 3, "mnc": 4, "lac": 5, "cellId": 6, "signal": 10},
}


def _clean(token: str) -> str:
    return token.strip().strip('"').strip()


def _to_int(token: str | None, base: int = 10) -> int | None:
    if token is None:
        return None
    token = _clean(token)
    if not token or token == "-":
        return None
    if base == 16 and token.lower().startswith("0x"):
        token = token[2:]
    try:
        return int(token, base)
    except ValueError:
        return None


def _split_fields(line: str) -> list[str]:
    body = line.split(":", 1)[1] if ":" in line else line
    return [_clean(part) for part in re.findall(r'"[^"]*"|[^,]+|(?<=,)(?=,)', body)]


def _signal_for(radio: str, value: int | None) -> int | None:
    if value is None:
        return None
    if radio == "GSM" and 0 <= value <= 63:
        # Some firmware report RxLev as 3GPP index 0..63 instead of dBm.
        return value - 110
    if -150 <= value <= 0:
        return value
    return None


def parse_qeng_serving_cell(response: str) -> dict | None:
    """Parse the first usable `+QENG: "servingcell",...` line. Never raises.

    Returns None for SEARCH / unknown radios / lines without a usable cell identity.
    lac (TAC for LTE) and cellId are decimal ints; mcc/mnc are ints.
    """
    if not isinstance(response, str):
        return None
    for raw_line in response.splitlines():
        line = raw_line.strip()
        if not line.startswith("+QENG:") or "servingcell" not in line:
            continue
        try:
            parsed = _parse_line(line)
        except Exception:  # noqa: BLE001 - defensive: a malformed line must never break the heartbeat
            parsed = None
        if parsed:
            return parsed
    return None


def _parse_line(line: str) -> dict | None:
    parts = _split_fields(line)
    if len(parts) < 3 or parts[0] != "servingcell":
        return None
    # parts[1] is the state: SEARCH, LIMSRV, NOCONN, CONNECT. SEARCH has no cell data.
    radio = parts[2].upper()
    layout = _LAYOUTS.get(radio)
    if layout is None:
        return None

    def field(name: str) -> str | None:
        idx = layout[name]
        return parts[idx] if idx < len(parts) else None

    mcc = _to_int(field("mcc"))
    mnc = _to_int(field("mnc"))
    lac = _to_int(field("lac"), 16)
    cell_id = _to_int(field("cellId"), 16)
    if mcc is None or mnc is None or lac is None or cell_id is None:
        return None

    return {
        "method": "cell_tower",
        "radio": radio.lower(),
        "mcc": mcc,
        "mnc": mnc,
        "lac": lac,
        "cellId": cell_id,
        "signalStrength": _signal_for(radio, _to_int(field("signal"))),
        "raw": line,
    }


# ---------------------------------------------------------------------------
# GNSS
# ---------------------------------------------------------------------------

NO_FIX = "no_fix"
NOT_ACTIVE = "not_active"
ERROR = "error"


def _utc_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _coord(token: str, positive: str, negative: str) -> float | None:
    token = token.strip()
    sign = 1.0
    if token and token[-1].upper() in (positive, negative):
        sign = -1.0 if token[-1].upper() == negative else 1.0
        token = token[:-1]
    try:
        return sign * float(token)
    except ValueError:
        return None


def parse_qgpsloc(response: str, now: datetime | None = None) -> tuple[str, dict | None]:
    """Parse an `AT+QGPSLOC=2` response. Returns (status, fix).

    status is "ok" (fix is a dict), NO_FIX (+CME ERROR: 516), NOT_ACTIVE (505: GNSS session
    not active) or ERROR (anything else, including empty output). Never raises.
    """
    now = now or datetime.now(timezone.utc)
    text = response if isinstance(response, str) else ""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line.startswith("+QGPSLOC:"):
            continue
        fields = [f.strip() for f in line.split(":", 1)[1].split(",")]
        # UTC,lat,lon,hdop,altitude,fix,cog,spkm,spkn,date,nsat
        if len(fields) < 10:
            return ERROR, None
        lat = _coord(fields[1], "N", "S")
        lon = _coord(fields[2], "E", "W")
        try:
            hdop = float(fields[3])
        except ValueError:
            hdop = None
        try:
            fix_type = int(fields[5])
        except ValueError:
            fix_type = 0
        try:
            speed_kmh = float(fields[7])
        except ValueError:
            speed_kmh = None
        if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            return ERROR, None
        if fix_type < 2 or (lat == 0 and lon == 0):
            return NO_FIX, None

        fix_time = _fix_time(fields[0], fields[9], now)
        fix = {
            "lat": round(lat, 6),
            "lng": round(lon, 6),
            "hdop": hdop,
            "speedKmh": speed_kmh,
            # Estimate: HDOP x ~5 m user-equivalent range error. The modem does not report metres.
            "accuracyM": int(round(hdop * 5)) if hdop is not None else None,
            "fixTime": fix_time,
        }
        return "ok", fix

    if "+CME ERROR: 516" in text or "+CME ERROR:516" in text:
        return NO_FIX, None
    if "+CME ERROR: 505" in text or "+CME ERROR:505" in text:
        return NOT_ACTIVE, None
    return ERROR, None


def _fix_time(utc_token: str, date_token: str, now: datetime) -> str:
    try:
        hh, mm, ss = int(utc_token[0:2]), int(utc_token[2:4]), int(float(utc_token[4:]))
        dd, mo, yy = int(date_token[0:2]), int(date_token[2:4]), int(date_token[4:6])
        return _utc_iso(datetime(2000 + yy, mo, dd, hh, mm, ss, tzinfo=timezone.utc))
    except (ValueError, IndexError):
        return _utc_iso(now)


def parse_qgps_state(response: str) -> bool | None:
    """`AT+QGPS?` -> True (on), False (off), None (not understood / unsupported)."""
    match = re.search(r"\+QGPS:\s*([01])", response if isinstance(response, str) else "")
    if not match:
        return None
    return match.group(1) == "1"


class GpsReader:
    """Reads GNSS fixes via injected AT access, with a time budget, backoff and a short cache.

    at(command, timeout_s) -> raw response text ("" on no answer).
    """

    def __init__(
        self,
        at: Callable[[str, float], str],
        enabled: bool = True,
        budget_s: float = 2.0,
        cache_window_s: float = 600.0,
        backoff_initial_s: float = 300.0,
        backoff_max_s: float = 3600.0,
        monotonic: Callable[[], float] = time.monotonic,
        wall_now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        logger=None,
    ) -> None:
        self.at = at
        self.enabled = enabled
        self.budget_s = budget_s
        self.cache_window_s = cache_window_s
        self.backoff_initial_s = backoff_initial_s
        self.backoff_max_s = backoff_max_s
        self.monotonic = monotonic
        self.wall_now = wall_now
        self.logger = logger
        self.backoff_until = 0.0
        self.consecutive_failures = 0
        self.gnss_on = False
        self.last_fix: dict | None = None
        self.last_fix_at = 0.0

    def read(self) -> dict | None:
        """Return a fix dict (lat,lng,hdop,speedKmh,accuracyM,fixTime) or None."""
        if not self.enabled:
            return None
        now = self.monotonic()
        if now < self.backoff_until:
            return self._cached(now)
        deadline = now + self.budget_s
        try:
            fix = self._read(deadline)
        except Exception as error:  # noqa: BLE001
            self._log("gps read raised: %s", error)
            self._fail()
            fix = None
        if fix:
            self.last_fix = fix
            self.last_fix_at = self.monotonic()
            return dict(fix)
        return self._cached(self.monotonic())

    def _cached(self, now: float) -> dict | None:
        if self.last_fix and now - self.last_fix_at <= self.cache_window_s:
            return dict(self.last_fix)  # fixTime remains the real time of the fix
        return None

    def _call(self, command: str, deadline: float) -> str | None:
        remaining = deadline - self.monotonic()
        if remaining <= 0.05:
            return None
        return self.at(command, min(remaining, 1.0))

    def _read(self, deadline: float) -> dict | None:
        if not self.gnss_on:
            response = self._call("AT+QGPS?", deadline)
            if response is None:
                return None  # out of budget; try again next heartbeat, not a failure
            state = parse_qgps_state(response)
            if state is None:
                self._fail()  # no answer, ERROR, or modem without GNSS
                return None
            if not state:
                response = self._call("AT+QGPS=1", deadline)
                if response is None:
                    return None
                # 504 = session already ongoing, which is fine.
                if "OK" not in response and "504" not in response:
                    self._fail()
                    return None
            self.gnss_on = True

        response = self._call("AT+QGPSLOC=2", deadline)
        if response is None:
            return None
        status, fix = parse_qgpsloc(response, self.wall_now())
        if status == "ok":
            self.consecutive_failures = 0
            return fix
        if status == NO_FIX:
            self.consecutive_failures = 0  # expected while the antenna is acquiring
            return None
        if status == NOT_ACTIVE:
            self.gnss_on = False  # re-enable on next read
            return None
        self._fail()
        return None

    def _fail(self) -> None:
        self.consecutive_failures += 1
        delay = min(self.backoff_initial_s * (2 ** (self.consecutive_failures - 1)), self.backoff_max_s)
        self.backoff_until = self.monotonic() + delay
        self.gnss_on = False
        self._log("gps error #%s, backing off %.0fs", self.consecutive_failures, delay)

    def _log(self, message: str, *args) -> None:
        if self.logger:
            self.logger.warning(message, *args)


def build_gps_location(fix: dict, cell: dict | None) -> dict:
    """Heartbeat location payload for a GPS fix, with the serving cell nested when known."""
    payload: dict = {
        "method": "gps",
        "lat": fix["lat"],
        "lng": fix["lng"],
        "accuracyM": fix.get("accuracyM"),
        "hdop": fix.get("hdop"),
        "speedKmh": fix.get("speedKmh"),
        "fixTime": fix.get("fixTime"),
    }
    if cell:
        payload["cell"] = {k: cell[k] for k in ("radio", "mcc", "mnc", "lac", "cellId")}
        payload["signalStrength"] = cell.get("signalStrength")
        payload["raw"] = cell.get("raw")
    return payload
