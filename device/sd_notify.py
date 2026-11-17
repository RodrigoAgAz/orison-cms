#!/usr/bin/env python3
"""Minimal systemd notify protocol (sd_notify(3)) using only the standard library.

A no-op when NOTIFY_SOCKET is not set (running by hand, in tests, on macOS).
"""

from __future__ import annotations

import os
import socket


def notify(message: str, environ: dict[str, str] | None = None) -> bool:
    """Send e.g. "READY=1" or "WATCHDOG=1". Returns True if a datagram was sent."""
    env = os.environ if environ is None else environ
    address = env.get("NOTIFY_SOCKET")
    if not address:
        return False
    if address.startswith("@"):
        address = "\0" + address[1:]  # abstract namespace socket
    elif not address.startswith("/"):
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1.0)
            sock.connect(address)
            sock.sendall(message.encode("utf-8"))
        return True
    except OSError:
        return False


def watchdog_interval_seconds(environ: dict[str, str] | None = None) -> float | None:
    """systemd's WATCHDOG_USEC for this process, in seconds, or None when no watchdog is armed."""
    env = os.environ if environ is None else environ
    usec = env.get("WATCHDOG_USEC")
    pid = env.get("WATCHDOG_PID")
    if not usec:
        return None
    if pid and pid != str(os.getpid()):
        return None
    try:
        value = int(usec)
    except ValueError:
        return None
    return value / 1_000_000 if value > 0 else None
