#!/usr/bin/env python3
"""Health monitor: heartbeats to the CMS and playback log delivery.

Every heartbeat field is collected defensively: a bad local file, a missing tool or an odd modem
answer leaves that field empty, it never stops the heartbeat (which is how the CMS knows the cab
is alive). Playback logs are sent on every heartbeat cycle while anything is queued.
"""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import psutil
import requests

from common import (
    BASE_DIR,
    FIRMWARE_VERSION,
    HEARTBEAT_INTERVAL_RANGE,
    LAST_LOCATION_PATH,
    PLAYER_STATE_PATH,
    SERVER_CONFIG_PATH,
    SYNC_INTERVAL_RANGE,
    SYNC_STATUS_PATH,
    atomic_write_json,
    build_headers,
    current_manifest_path,
    effective_interval,
    ensure_directories,
    installed_safety,
    load_config,
    read_json_dict,
    setup_logger,
)
from log_queue import PlaybackLogQueue, downgrade_for_old_server, sanitize_entry
from modem import GpsReader, build_gps_location, parse_qeng_serving_cell
from netinfo import (
    NETWORK_TYPES,
    classify_interface,
    default_route_interface,
    mm_cell_location,
    mm_gps_fix,
    mm_modem_summary,
    mm_signal_dbm,
    mmcli_first_modem,
    nmcli_wwan_signal,
    parse_mmcli_kv,
    parse_nmcli_device_show,
    parse_nmcli_device_status,
    parse_nmcli_wifi_signal,
)
from sync_signal import SyncRequester, consume_heartbeat_request, decide_sync_reasons

__all__ = ["HealthMonitor", "FIRMWARE_VERSION", "AT_PORT_CANDIDATES"]

# Where a modem's AT command port appears, in probing order. Only probed when ModemManager is not
# running (it owns the ports when it is) or when modem.atPort names a port explicitly.
AT_PORT_CANDIDATES = [
    Path("/dev/wwan0at0"),  # Linux WWAN subsystem: M.2/PCIe modems (MHI), e.g. Quectel RM5xx/EM1xx
    Path("/dev/wwan0at1"),
    Path("/dev/ttyUSB2"),  # USB modems and M.2 cards in USB mode (Quectel: ttyUSB2 is the AT port)
    Path("/dev/ttyUSB3"),
    Path("/dev/ttyUSB1"),
    Path("/dev/ttyUSB0"),
    Path("/dev/ttyACM0"),  # cdc-acm modems
    Path("/dev/ttyACM1"),
    Path("/dev/ttyACM2"),
    Path("/dev/serial0"),  # UART modem HAT on a Raspberry Pi
]

PLAYER_STATUSES = {"playing", "silent", "disabled", "idle", "fallback", "error", "unknown"}
PLAYER_STALE_SECONDS = 60
UPLOAD_BACKOFF_INITIAL_SECONDS = 60
UPLOAD_BACKOFF_MAX_SECONDS = 3600
MAX_BATCHES_PER_CYCLE = 25
OLD_SERVER_MODE_MEMORY_SECONDS = 6 * 3600
HEARTBEAT_REQUEST_POLL_SECONDS = 5
COMMAND_TIMEOUT_SECONDS = 5
PREFERRED_THERMAL_ZONES = ("x86_pkg_temp", "coretemp", "k10temp", "cpu-thermal", "cpu_thermal", "soc_thermal", "acpitz")


def _safe(fn: Callable[[], Any], default: Any = None) -> Any:
    try:
        return fn()
    except Exception:  # noqa: BLE001 - one bad field must not stop the heartbeat
        return default


class HealthMonitor:
    def __init__(self) -> None:
        self.config = load_config()
        self.logger = setup_logger("orison-health", "health.log")
        self.session = requests.Session()
        self.queue = PlaybackLogQueue(max_bytes=self.config.max_log_queue_bytes, logger=self.logger)
        self.at_port: Path | None = None
        self.sync_requester = SyncRequester()
        self.gps = GpsReader(
            at=self.gps_at,
            enabled=self.config.gps_enabled,
            logger=self.logger,
        )
        self.upload_failures = 0
        self.upload_retry_at = 0.0
        self.old_server_modes_until = 0.0
        self.heartbeat_failures = 0
        self._mm_running: bool | None = None

    # ------------------------------------------------------------------ main loop
    def run(self) -> None:
        ensure_directories()
        while True:
            ok = False
            try:
                self.send_heartbeat()
                ok = True
            except Exception as error:  # noqa: BLE001
                self.logger.warning("heartbeat failed: %s", error)
            try:
                self.upload_logs()
            except Exception as error:  # noqa: BLE001
                self.logger.exception("playback log upload failed: %s", error)
            interval = self.heartbeat_interval()
            if ok:
                self.heartbeat_failures = 0
                delay = interval
            else:
                self.heartbeat_failures += 1
                delay = min(30 * 2 ** (self.heartbeat_failures - 1), interval)
            self.wait(delay)

    def wait(self, seconds: float) -> None:
        """Sleep, waking early when the sync agent asks for an immediate heartbeat."""
        deadline = time.monotonic() + seconds
        while True:
            if consume_heartbeat_request() is not None:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(HEARTBEAT_REQUEST_POLL_SECONDS, remaining))

    def heartbeat_interval(self) -> int:
        return effective_interval(self.config.heartbeat_interval_seconds, "heartbeatIntervalSeconds", HEARTBEAT_INTERVAL_RANGE)

    # ------------------------------------------------------------------ heartbeat
    def build_heartbeat(self) -> dict[str, Any]:
        self._mm_running = None
        manifest = read_json_dict(current_manifest_path())
        player = _safe(self.player_status, {"status": "unknown"})
        network = _safe(self.network_snapshot, {}) or {}
        location = _safe(lambda: self.current_location(network), None)
        _safe(lambda: self.write_runtime_location(location))

        signal_dbm = None
        if isinstance(location, dict):
            value = location.get("signalStrength")
            if isinstance(value, (int, float)) and not isinstance(value, bool) and -160 <= value < 0:
                signal_dbm = int(value)
        if signal_dbm is None:
            signal_dbm = network.get("signalDbm")
        network_type = network.get("networkType")
        loop_id = manifest.get("loopId")

        payload = {
            "serialNumber": self.config.serial_number,
            "ipAddress": _safe(self.current_ip),
            "firmwareVersion": _safe(self.firmware_version, FIRMWARE_VERSION),
            "storageFreeMb": _safe(lambda: int(shutil.disk_usage(BASE_DIR).free / (1024 * 1024))),
            "currentLoopId": loop_id if isinstance(loop_id, str) else None,
            "cpuTemp": _safe(self.cpu_temp_c),
            "uptimeSeconds": _safe(lambda: max(int(time.time() - psutil.boot_time()), 0)),
            "memoryUsedPercent": _safe(lambda: float(psutil.virtual_memory().percent)),
            "playerStatus": player.get("status", "unknown"),
            "playerState": player.get("state"),
            "playbackTrigger": player.get("trigger"),
            "networkType": network_type if network_type in NETWORK_TYPES else "unknown",
            "signalStrength": signal_dbm,
            "signalPercent": network.get("signalPercent"),
            "safetyChecksum": _safe(lambda: (installed_safety() or {}).get("checksum")),
            "sync": _safe(self.sync_status),
            "location": location,
            "logQueue": _safe(self.queue.status),
            "display": player.get("display"),
        }
        return payload

    def send_heartbeat(self) -> dict | None:
        payload = self.build_heartbeat()
        response = self.session.post(
            f"{self.config.api_base_url}/devices/heartbeat",
            headers=build_headers(self.config),
            data=json.dumps(payload),
            timeout=30,
        )
        response.raise_for_status()
        self.logger.info("heartbeat sent")
        try:
            body = response.json()
        except ValueError:
            body = None
        _safe(lambda: self.adopt_server_config(body))
        _safe(lambda: self.request_sync_if_needed(body))
        return body if isinstance(body, dict) else None

    def player_status(self) -> dict[str, Any]:
        """What the player last reported; 'error' when its state file is stale (player dead)."""
        state = read_json_dict(PLAYER_STATE_PATH)
        if not state:
            return {"status": "unknown"}
        status = state.get("status") if state.get("status") in PLAYER_STATUSES else "unknown"
        updated = _parse_iso(state.get("updatedAt"))
        if updated is None or time.time() - updated > PLAYER_STALE_SECONDS:
            status = "error"
        trigger = state.get("trigger") if state.get("trigger") in ("gpio", "keyboard", "always") else None
        display = state.get("display") if isinstance(state.get("display"), dict) else None
        return {"status": status, "state": state.get("state"), "trigger": trigger, "display": display}

    def sync_status(self) -> dict[str, Any] | None:
        status = read_json_dict(SYNC_STATUS_PATH)
        if not status.get("state"):
            return None
        error = status.get("error")
        return {
            "state": status.get("state"),
            "error": str(error)[:300] if error else None,
            "failedLoopId": status.get("failedLoopId"),
            "since": status.get("since"),
            "lastSyncedAt": status.get("lastSyncedAt"),
            "nextRetryAt": status.get("nextRetryAt"),
        }

    def adopt_server_config(self, body: Any) -> None:
        """Adopt heartbeat/sync intervals from the CMS (clamped); config.json when it sends none."""
        if not isinstance(body, dict):
            return
        server = body.get("config")
        if not isinstance(server, dict):
            if "config" not in body and SERVER_CONFIG_PATH.exists():
                SERVER_CONFIG_PATH.unlink(missing_ok=True)
            return
        adopted: dict[str, Any] = {}
        for key, bounds in (("heartbeatIntervalSeconds", HEARTBEAT_INTERVAL_RANGE), ("syncIntervalSeconds", SYNC_INTERVAL_RANGE)):
            value = server.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                adopted[key] = int(min(max(value, bounds[0]), bounds[1]))
        current = read_json_dict(SERVER_CONFIG_PATH)
        if {k: current.get(k) for k in adopted} != adopted or set(current) - set(adopted) - {"receivedAt"}:
            atomic_write_json(SERVER_CONFIG_PATH, {**adopted, "receivedAt": time.time()})
            self.logger.info("adopted server config %s", adopted)

    def request_sync_if_needed(self, body: object) -> bool:
        """Compare the server's expectations with local state; ask sync_agent to sync now if they differ."""
        manifest = read_json_dict(current_manifest_path())
        player_state = read_json_dict(PLAYER_STATE_PATH)
        local_disabled = player_state.get("disabled")
        safety = installed_safety()
        reasons = decide_sync_reasons(
            body,
            manifest.get("loopId"),
            manifest.get("checksum"),
            local_disabled if isinstance(local_disabled, bool) else None,
            local_safety_checksum=(safety or {}).get("checksum"),
        )
        if not reasons or not isinstance(body, dict):
            return False
        expected = {k: body.get(k) for k in ("expectedLoopId", "expectedChecksum", "disabled", "expectedSafetyChecksum")}
        written = self.sync_requester.maybe_request(reasons, expected)
        if written:
            self.logger.info("requested immediate sync: %s", ",".join(reasons))
        return written

    # ------------------------------------------------------------------ playback log upload
    def upload_logs(self) -> None:
        """Send queued playback log segments (contract: Playback log)."""
        if time.time() < self.upload_retry_at:
            return
        self.queue.rotate()
        sent = 0
        for segment in self.queue.segments():
            if sent >= MAX_BATCHES_PER_CYCLE:
                break
            entries = self.queue.read_segment(segment)
            if entries:
                outcome = self.post_batch(entries)
                if outcome == "retry":
                    self.upload_failures += 1
                    delay = min(UPLOAD_BACKOFF_INITIAL_SECONDS * 2 ** (self.upload_failures - 1), UPLOAD_BACKOFF_MAX_SECONDS)
                    self.upload_retry_at = time.time() + delay
                    self.logger.warning("playback log upload will be retried in %ss", delay)
                    return
                if outcome == "ok":
                    self.logger.info("uploaded %s playback log entries", len(entries))
            self.queue.remove_segment(segment)
            sent += 1
        self.upload_failures = 0

    def post_batch(self, entries: list[dict[str, Any]]) -> str:
        """'ok' (remove), 'rejected' (dead-lettered, remove) or 'retry' (keep)."""
        clean: list[dict[str, Any]] = []
        invalid: list[dict[str, Any]] = []
        for entry in entries:
            shaped = sanitize_entry(entry)
            (clean if shaped is not None else invalid).append(shaped if shaped is not None else entry)
        if invalid:
            self.queue.dead_letter(invalid, "not sendable (no valid playedAt)")
        if not clean:
            return "ok"

        batch = clean
        if time.time() < self.old_server_modes_until:
            batch, _ = downgrade_for_old_server(clean)
        status, body = self._post_logs(batch)
        if status is None:
            self.logger.warning("playback log upload failed: %s", body)
            return "retry"
        if 200 <= status < 300:
            self._dead_letter_rejected(batch, body)
            return "ok"
        if status in (400, 413, 422):
            downgraded, changed = downgrade_for_old_server(batch)
            if changed:
                status2, body2 = self._post_logs(downgraded)
                if status2 is not None and 200 <= status2 < 300:
                    self.old_server_modes_until = time.time() + OLD_SERVER_MODE_MEMORY_SECONDS
                    self.logger.info("server does not accept mode 'continuous'; sent those entries as 'journey'")
                    self._dead_letter_rejected(downgraded, body2)
                    return "ok"
                if status2 in (400, 413, 422):
                    self.queue.dead_letter(clean, f"HTTP {status2}: {_snippet(body2)}")
                    self.logger.error("playback log batch rejected (HTTP %s), moved to dead letter: %s", status2, _snippet(body2))
                    return "rejected"
                return "retry"
            self.queue.dead_letter(clean, f"HTTP {status}: {_snippet(body)}")
            self.logger.error("playback log batch rejected (HTTP %s), moved to dead letter: %s", status, _snippet(body))
            return "rejected"
        self.logger.warning("playback log upload got HTTP %s; keeping the batch", status)
        return "retry"

    def _post_logs(self, entries: list[dict[str, Any]]) -> tuple[int | None, Any]:
        try:
            response = self.session.post(
                f"{self.config.api_base_url}/devices/playback-log",
                headers=build_headers(self.config),
                data=json.dumps({"serialNumber": self.config.serial_number, "logs": entries}),
                timeout=30,
            )
        except requests.RequestException as error:
            return None, str(error)
        try:
            body: Any = response.json()
        except ValueError:
            body = response.text[:300] if isinstance(response.text, str) else None
        return response.status_code, body

    def _dead_letter_rejected(self, sent: list[dict[str, Any]], body: Any) -> None:
        if not isinstance(body, dict) or not isinstance(body.get("rejected"), list):
            return
        rejected = []
        for item in body["rejected"]:
            if isinstance(item, dict) and isinstance(item.get("index"), int) and 0 <= item["index"] < len(sent):
                rejected.append({**sent[item["index"]], "_reason": str(item.get("reason"))[:200]})
        if rejected:
            self.queue.dead_letter(rejected, "rejected by server")
            self.logger.warning("server rejected %s playback log entries (see logs/playback.dead.jsonl)", len(rejected))

    # ------------------------------------------------------------------ system facts
    def current_ip(self) -> str | None:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(("8.8.8.8", 80))
                return sock.getsockname()[0]
        except OSError:
            return None

    def cpu_temp_c(self, thermal_root: Path = Path("/sys/class/thermal")) -> float | None:
        best: tuple[int, float] | None = None
        try:
            zones = sorted(thermal_root.glob("thermal_zone*"))
        except OSError:
            zones = []
        for zone in zones:
            try:
                zone_type = (zone / "type").read_text(encoding="utf-8").strip()
                value = int((zone / "temp").read_text(encoding="utf-8").strip()) / 1000.0
            except (OSError, ValueError):
                continue  # some x86 zones refuse reads (EIO/ENODATA)
            if not 0 < value < 150:
                continue
            rank = PREFERRED_THERMAL_ZONES.index(zone_type) if zone_type in PREFERRED_THERMAL_ZONES else len(PREFERRED_THERMAL_ZONES)
            if best is None or rank < best[0]:
                best = (rank, value)
        if best is not None:
            return round(best[1], 1)
        sensors = getattr(psutil, "sensors_temperatures", None)
        if sensors is None:
            return None
        try:
            readings = sensors() or {}
        except Exception:  # noqa: BLE001
            return None
        for name in ("coretemp", "k10temp", "cpu_thermal", "acpitz", *readings.keys()):
            for reading in readings.get(name, []):
                if reading.current and 0 < reading.current < 150:
                    return round(float(reading.current), 1)
        return None

    def firmware_version(self) -> str:
        version_path = BASE_DIR / "VERSION"
        try:
            value = version_path.read_text(encoding="utf-8").strip()
            if value:
                return value[:32]
        except OSError:
            pass
        return FIRMWARE_VERSION

    def write_runtime_location(self, location: dict | None) -> None:
        if location is None:
            LAST_LOCATION_PATH.unlink(missing_ok=True)
            return
        atomic_write_json(LAST_LOCATION_PATH, location, durable=False)

    def extract_signal_strength(self, location: dict | None) -> int | None:
        if not location:
            return None
        value = location.get("signalStrength")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
        return None

    # ------------------------------------------------------------------ network and modem
    def run_command(self, args: list[str]) -> str | None:
        if not shutil.which(args[0]):
            return None
        try:
            result = subprocess.run(args, capture_output=True, check=False, text=True, timeout=COMMAND_TIMEOUT_SECONDS)
        except (OSError, subprocess.SubprocessError):
            return None
        return result.stdout if result.returncode == 0 else None

    def modemmanager_running(self) -> bool:
        if self._mm_running is None:
            try:
                self._mm_running = any(
                    (proc.info.get("name") or "") == "ModemManager" for proc in psutil.process_iter(["name"])
                )
            except Exception:  # noqa: BLE001
                self._mm_running = False
        return self._mm_running

    def mm_query(self) -> dict[str, Any]:
        """ModemManager's view of the first modem (signal, technology, cell, GPS), via mmcli."""
        listing = self.run_command(["mmcli", "-L", "-K"])
        if not listing:
            return {}
        modem = mmcli_first_modem(parse_mmcli_kv(listing))
        if not modem:
            return {}
        result: dict[str, Any] = {}
        info = self.run_command(["mmcli", "-m", modem, "-K"])
        if info:
            result.update(mm_modem_summary(parse_mmcli_kv(info)))
        signal = self.run_command(["mmcli", "-m", modem, "--signal-get", "-K"])
        if signal:
            result["signalDbm"] = mm_signal_dbm(parse_mmcli_kv(signal))
        location = self.run_command(["mmcli", "-m", modem, "--location-get", "-K"])
        if location:
            parsed = parse_mmcli_kv(location)
            result["cell"] = mm_cell_location(parsed, result.get("technology"))
            result["gps"] = mm_gps_fix(parsed)
        return result

    def network_snapshot(self) -> dict[str, Any]:
        """{networkType, signalDbm, signalPercent, operator, interface, modem}: each part optional."""
        snapshot: dict[str, Any] = {}
        nm_devices: dict[str, dict[str, str]] = {}
        status_text = self.run_command(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE", "device", "status"])
        if status_text:
            nm_devices = parse_nmcli_device_status(status_text)
        try:
            route_text = Path("/proc/net/route").read_text(encoding="utf-8")
        except OSError:
            route_text = ""
        interface = default_route_interface(route_text)
        snapshot["interface"] = interface
        snapshot["networkType"] = classify_interface(interface, nm_types={k: v["type"] for k, v in nm_devices.items()})

        modem = _safe(self.mm_query, {}) or {}
        snapshot["modem"] = modem
        snapshot["signalDbm"] = modem.get("signalDbm")
        snapshot["signalPercent"] = modem.get("signalPercent")
        snapshot["operator"] = modem.get("operator")

        if snapshot["signalPercent"] is None and any(d["type"] in ("gsm", "cdma") for d in nm_devices.values()):
            show = self.run_command(
                ["nmcli", "-t", "-f", "GENERAL.DEVICE,GENERAL.TYPE,WWAN.SIGNAL,WWAN.OPERATOR", "device", "show"]
            )
            if show:  # older/other nmcli builds have no WWAN.* fields and fail: that is fine
                percent, operator = nmcli_wwan_signal(parse_nmcli_device_show(show))
                snapshot["signalPercent"] = percent
                snapshot["operator"] = snapshot["operator"] or operator
        if snapshot["signalPercent"] is None and snapshot["networkType"] == "wifi":
            wifi = self.run_command(["nmcli", "-t", "-f", "IN-USE,SIGNAL", "device", "wifi", "list", "--rescan", "no"])
            if wifi:
                snapshot["signalPercent"] = parse_nmcli_wifi_signal(wifi)
        return snapshot

    def current_location(self, network: dict[str, Any] | None = None) -> dict | None:
        if platform.system() == "Darwin":
            return None

        cell = None
        fix = None
        if self.at_ports_allowed():
            cell = self.location_via_serial()
            fix = self.gps.read() if self.at_port is not None else None
        if fix:
            return build_gps_location(fix, cell)
        if cell:
            return cell
        modem = (network or {}).get("modem") or {}
        mm_cell = modem.get("cell")
        if modem.get("gps"):
            return build_gps_location(modem["gps"], mm_cell)
        if mm_cell:
            return {**mm_cell, "signalStrength": modem.get("signalDbm")}
        return None

    def at_ports_allowed(self) -> bool:
        setting = self.config.at_port
        if setting.lower() == "none":
            return False
        if setting.lower() != "auto":
            return True
        if self.modemmanager_running():
            return False  # ModemManager owns the modem's ports: do not fight it, use mmcli instead
        return True

    def at_port_candidates(self) -> list[Path]:
        setting = self.config.at_port
        if setting.lower() not in ("auto", "none"):
            return [Path(setting)]
        return list(AT_PORT_CANDIDATES)

    def location_via_serial(self) -> dict | None:
        candidates = self.at_port_candidates()
        if self.at_port in candidates:
            candidates.remove(self.at_port)
            candidates.insert(0, self.at_port)

        for port in candidates:
            if not port.exists():
                continue

            response = self.run_at_command(port, 'AT+QENG="servingcell"')
            if "OK" in response or "+QENG" in response:
                self.at_port = port  # this is the AT port (also used for GNSS), even if SEARCHing
            parsed = self.parse_qeng_serving_cell(response)
            if parsed:
                return parsed
            if self.at_port == port:
                break

        return None

    def gps_at(self, command: str, timeout_s: float) -> str:
        if self.at_port is None:
            return ""
        return self.run_at_command(self.at_port, command, timeout_s)

    def run_at_command(self, port: Path, command: str, timeout_s: float = 1.5) -> str:
        try:
            import termios
        except ImportError:
            return ""
        try:
            fd = os.open(str(port), os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        except OSError:
            return ""
        try:
            attrs = termios.tcgetattr(fd)
            attrs[0] = 0
            attrs[1] = 0
            attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
            attrs[3] = 0
            attrs[4] = termios.B115200
            attrs[5] = termios.B115200
            termios.tcsetattr(fd, termios.TCSANOW, attrs)

            os.write(fd, b"\r")
            time.sleep(0.05)
            try:
                os.read(fd, 4096)
            except BlockingIOError:
                pass

            os.write(fd, f"{command}\r".encode("utf-8"))

            chunks: list[bytes] = []
            deadline = time.monotonic() + timeout_s
            while time.monotonic() < deadline:
                try:
                    chunk = os.read(fd, 4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    tail = b"".join(chunks)
                    # Final result code reached: stop waiting instead of burning the full timeout.
                    if re.search(rb"(^|\r\n)(OK|ERROR|\+CME ERROR:[^\r\n]*)\r\n", tail):
                        break
                except BlockingIOError:
                    time.sleep(0.03)

            return b"".join(chunks).decode("utf-8", errors="ignore")
        except OSError:
            return ""
        finally:
            os.close(fd)

    def parse_qeng_serving_cell(self, response: str) -> dict | None:
        return parse_qeng_serving_cell(response)


def _parse_iso(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _snippet(body: Any) -> str:
    try:
        text = body if isinstance(body, str) else json.dumps(body)
    except (TypeError, ValueError):
        text = str(body)
    return text[:200]


if __name__ == "__main__":
    HealthMonitor().run()
