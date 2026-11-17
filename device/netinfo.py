#!/usr/bin/env python3
"""Network and modem information for the heartbeat, from Linux, NetworkManager and ModemManager.

Parsers are pure functions over command output so they can be tested anywhere. Nothing in here may
raise into the heartbeat: callers wrap the command runs, and parsers return None/{} on odd input.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

NETWORK_TYPES = ("4g", "ethernet", "wifi", "unknown")  # what the server accepts (strict enum)

# Kernel drivers of USB/PCIe cellular modems' network interfaces.
WWAN_DRIVERS = {
    "qmi_wwan",
    "cdc_mbim",
    "cdc_ncm",
    "huawei_cdc_ncm",
    "rndis_host",
    "cdc_ether",
    "mhi_net",
    "mhi_wwan_mbim",
    "ipheth",
    "sierra_net",
    "GobiNet",
    "option",
}


# --------------------------------------------------------------------------- default route
def default_route_interface(proc_net_route: str) -> str | None:
    """Interface of the lowest-metric default IPv4 route in /proc/net/route text."""
    best: tuple[int, str] | None = None
    for line in proc_net_route.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 8:
            continue
        iface, destination, flags, metric, mask = fields[0], fields[1], fields[3], fields[6], fields[7]
        try:
            up = int(flags, 16) & 0x1
            metric_value = int(metric)
        except ValueError:
            continue
        if destination == "00000000" and mask == "00000000" and up:
            if best is None or metric_value < best[0]:
                best = (metric_value, iface)
    return best[1] if best else None


def classify_interface(name: str | None, sysfs: Path = Path("/sys/class/net"),
                       nm_types: dict[str, str] | None = None) -> str:
    """'4g' | 'wifi' | 'ethernet' | 'unknown' for a network interface."""
    if not name:
        return "unknown"
    nm_type = (nm_types or {}).get(name, "")
    if nm_type in ("gsm", "cdma", "modem", "wwan"):
        return "4g"
    if nm_type == "wifi":
        return "wifi"
    base = sysfs / name
    if (base / "wireless").exists() or (base / "phy80211").exists():
        return "wifi"
    try:
        uevent = (base / "uevent").read_text(encoding="utf-8", errors="replace")
    except OSError:
        uevent = ""
    if "DEVTYPE=wwan" in uevent:
        return "4g"
    if "DEVTYPE=wlan" in uevent:
        return "wifi"
    try:
        driver = os.path.basename(os.readlink(base / "device" / "driver"))
    except OSError:
        driver = ""
    if driver in WWAN_DRIVERS:
        return "4g"
    if name.startswith(("ww", "rmnet", "usb", "mhi")):
        return "4g"
    if name.startswith("wl"):
        return "wifi"
    if name.startswith(("en", "eth")) or nm_type == "ethernet":
        return "ethernet"
    return "unknown"


# --------------------------------------------------------------------------- nmcli
def split_nmcli_terse(line: str) -> list[str]:
    """Split one `nmcli -t` line on unescaped ':' and unescape '\\:' and '\\\\'."""
    fields, current, escaped = [], [], False
    for char in line:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == ":":
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
    fields.append("".join(current))
    return fields


def parse_nmcli_device_status(text: str) -> dict[str, dict[str, str]]:
    """`nmcli -t -f DEVICE,TYPE,STATE device status` -> {device: {type, state}}."""
    devices: dict[str, dict[str, str]] = {}
    for line in text.splitlines():
        fields = split_nmcli_terse(line.strip())
        if len(fields) >= 3 and fields[0]:
            devices[fields[0]] = {"type": fields[1], "state": fields[2]}
    return devices


def parse_nmcli_device_show(text: str) -> list[dict[str, str]]:
    """`nmcli -t -f ... device show` -> one dict per device (each device's lines kept together,
    so a later device can never overwrite an earlier one's values)."""
    blocks: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            if current:
                blocks.append(current)
                current = {}
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key == "GENERAL.DEVICE" and current:
            blocks.append(current)
            current = {}
        current[key] = value.strip().replace("\\:", ":")
    if current:
        blocks.append(current)
    return blocks


def nmcli_wwan_signal(blocks: list[dict[str, str]]) -> tuple[int | None, str | None]:
    """(signal percent, operator) from the first cellular device that reports them."""
    for block in blocks:
        raw = block.get("WWAN.SIGNAL", "")
        match = re.match(r"^\s*(\d{1,3})", raw)
        if match and block.get("GENERAL.TYPE", "gsm") in ("gsm", "cdma", "modem", "wwan"):
            value = int(match.group(1))
            if 0 <= value <= 100:
                return value, block.get("WWAN.OPERATOR") or None
    return None, None


def parse_nmcli_wifi_signal(text: str) -> int | None:
    """`nmcli -t -f IN-USE,SIGNAL device wifi list --rescan no` -> signal % of the connected AP."""
    for line in text.splitlines():
        fields = split_nmcli_terse(line.strip())
        if len(fields) >= 2 and fields[0] == "*" and fields[1].isdigit():
            return max(0, min(int(fields[1]), 100))
    return None


# --------------------------------------------------------------------------- mmcli
def parse_mmcli_kv(text: str) -> dict[str, Any]:
    """`mmcli ... -K` key-value output. Array items `key.value[1]` are also collected as a list
    under `key.value`. '--' (no value) becomes None."""
    data: dict[str, Any] = {}
    for raw in text.splitlines():
        if ":" not in raw:
            continue
        key, value = raw.split(":", 1)
        key, value = key.strip(), value.strip()
        if not key:
            continue
        parsed: str | None = None if value in ("--", "") else value
        match = re.match(r"^(.*)\[(\d+)\]$", key)
        if match:
            base = match.group(1)
            existing = data.get(base)
            if not isinstance(existing, list):
                existing = []
                data[base] = existing
            if parsed is not None:
                existing.append(parsed)
        data[key] = parsed
    return data


def mmcli_first_modem(listing: dict[str, Any]) -> str | None:
    modems = listing.get("modem-list.value")
    if isinstance(modems, list) and modems:
        return str(modems[0])
    return None


def _number(value: Any) -> float | None:
    if value is None:
        return None
    match = re.match(r"^\s*(-?\d+(?:\.\d+)?)", str(value))
    return float(match.group(1)) if match else None


def mm_modem_summary(info: dict[str, Any]) -> dict[str, Any]:
    """Signal quality %, access technology and operator from `mmcli -m <modem> -K`."""
    quality = _number(info.get("modem.generic.signal-quality.value"))
    technologies = info.get("modem.generic.access-technologies.value")
    if isinstance(technologies, list):
        technology = technologies[0] if technologies else None
    else:
        technology = info.get("modem.generic.access-technologies")
    return {
        "signalPercent": int(quality) if quality is not None and 0 <= quality <= 100 else None,
        "technology": str(technology).lower() if technology else None,
        "operator": info.get("modem.3gpp.operator-name"),
        "state": info.get("modem.generic.state"),
    }


def mm_signal_dbm(signal: dict[str, Any]) -> int | None:
    """Best available dBm from `mmcli -m <modem> --signal-get -K` (RSRP preferred)."""
    for key in (
        "modem.signal.lte.rsrp",
        "modem.signal.5g.rsrp",
        "modem.signal.umts.rscp",
        "modem.signal.lte.rssi",
        "modem.signal.umts.rssi",
        "modem.signal.gsm.rssi",
    ):
        value = _number(signal.get(key))
        if value is not None and -160 <= value < 0:
            return int(round(value))
    return None


def _radio_for(technology: str | None) -> str | None:
    tech = (technology or "").lower()
    if tech.startswith(("lte", "5gnr")):
        return "lte"
    if tech in ("umts", "hsdpa", "hsupa", "hspa", "hspa-plus") or tech.startswith("hspa"):
        return "wcdma"
    if tech in ("gsm", "gsm-compact", "gprs", "edge"):
        return "gsm"
    return None


def _hex(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value), 16)
    except ValueError:
        return None


def mm_cell_location(location: dict[str, Any], technology: str | None) -> dict[str, Any] | None:
    """Serving cell from `mmcli -m <modem> --location-get -K` in the heartbeat's cell_tower shape."""
    radio = _radio_for(technology)
    try:
        mcc = int(str(location.get("modem.location.3gpp.mcc")))
        mnc = int(str(location.get("modem.location.3gpp.mnc")))
    except ValueError:
        return None
    tac = _hex(location.get("modem.location.3gpp.tac"))
    lac = _hex(location.get("modem.location.3gpp.lac"))
    cell_id = _hex(location.get("modem.location.3gpp.cid"))
    area = tac if radio == "lte" and tac else (lac or tac)
    if radio is None or not mcc or cell_id in (None, 0) or area is None:
        return None
    return {"method": "cell_tower", "radio": radio, "mcc": mcc, "mnc": mnc, "lac": area, "cellId": cell_id, "source": "modemmanager"}


def mm_gps_fix(location: dict[str, Any]) -> dict[str, Any] | None:
    lat = _number(location.get("modem.location.gps.latitude"))
    lng = _number(location.get("modem.location.gps.longitude"))
    if lat is None or lng is None or not (-90 <= lat <= 90) or not (-180 <= lng <= 180) or (lat == 0 and lng == 0):
        return None
    return {"lat": round(lat, 6), "lng": round(lng, 6), "hdop": None, "speedKmh": None, "accuracyM": None, "fixTime": None}
