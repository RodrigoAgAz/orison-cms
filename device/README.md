# Orison cab firmware

Runs on the box in the cab and drives the rear screen. Three systemd services, all as user `orison`
from `/opt/orison`:

| Service | Program | Job |
|---|---|---|
| `orison-player` | `player_manager.py` | Plays content with mpv, reads passenger inputs, writes the playback log |
| `orison-sync` | `sync_agent.py` | Downloads what the CMS assigns to this cab, verifies it, activates it |
| `orison-health` | `health_monitor.py` | Heartbeats (status, network, location) and playback log upload |

Firmware version: see `VERSION` (currently 1.2.0).

## Supported hardware

- **x86-64 box running Debian 11+/Ubuntu 20.04+** (the pilot cab). No GPIO: journeys cannot be
  detected, so it runs in `always` mode (see below). Network facts come from NetworkManager and
  ModemManager when present.
- **Raspberry Pi OS** (Bullseye or later). GPIO inputs on BCM 17 (passenger mute button),
  18 (door sensor) and 27 (driver override), all active low with pull-ups.
- Either: systemd, Python 3.8+, mpv, a screen on HDMI/DP/eDP. Optional cellular modem: Quectel AT
  commands are used directly when ModemManager is not running; otherwise `mmcli` is used.

## Trigger modes (`playback.trigger`)

| Value | Journeys start from | Notes |
|---|---|---|
| `auto` (default, also when the key is missing) | GPIO if it can be set up, else the keyboard if stdin is a terminal, else `always` | Under systemd stdin is never a terminal, so an x86 box gets `always` |
| `gpio` | Door sensor pin | Falls back like `auto` (and logs an error) if GPIO is unavailable |
| `keyboard` | `j` key (space = mute, `d` = driver override) | For bench testing from a terminal |
| `always` | No passenger detection | Safety message, one full pass of the loop, repeat |

In `always` mode the safety message is shown before every pass, or every Nth pass with
`playback.alwaysSafetyEveryCycles`. Plays are logged with mode `continuous` and no
JOURNEY_START/END events. The mute button still mutes (stills of the current slot); the driver
override restarts the cycle from the safety message. The door input is ignored. The active
trigger is shown in each heartbeat (`playbackTrigger`) and in `runtime/player_state.json`.

Between journeys (gpio/keyboard) the screen shows each slot's still in turn, one slot length each.
A loop uploaded as a single video (no slots) shows the default still.

## Configuration: `/opt/orison/config.json`

Only `device.*` is required. Keys that are missing take the default below; keys from older
firmware that are no longer read (`device.cdnBaseUrl`, `playback.loopContinuously`,
`playback.screenResolution`, `health.logUploadIntervalSeconds`, `health.maxLogRetentionDays`)
are ignored. `config.json.template` lists every key.

| Key | Default | Meaning |
|---|---|---|
| `device.serialNumber` | required | Cab serial as registered in the CMS |
| `device.apiBaseUrl` | required | e.g. `https://cms.orisonscreens.com/api` |
| `device.apiToken` | required | Device token |
| `sync.checkIntervalSeconds` | 1800 | Content check interval. Overridden by the CMS setting when the server sends one (clamped 300..86400) |
| `sync.maxDownloadRetries` | 3 | Attempts per file per sync cycle (resumed with Range) |
| `sync.downloadTimeoutSeconds` | 300 | Socket timeout per request |
| `sync.maxBandwidthBytesPerSec` | 2000000 | Download throttle; 0 = unlimited |
| `sync.minFreeSpaceMb` | 200 | Disk space always left free; downloads that would eat into it are refused |
| `sync.cacheMaxMb` | 1024 | Size cap for verified files kept for reuse beyond the current and previous loops |
| `playback.trigger` | `auto` | See above |
| `playback.alwaysSafetyEveryCycles` | 1 | `always` mode: safety message every Nth pass |
| `playback.fallbackContentPath` | `/opt/orison/content/fallback/orison_fallback.mp4` | Played if no content has ever synced. Optional: without it the default still is shown |
| `playback.display.videoOutput` | `auto` | `auto`: DRM straight to the screen when no desktop session is running, else mpv's own choice; the other is tried if the first keeps failing. `drm`, or any mpv `--vo` value |
| `playback.display.drmConnector` | `auto` | e.g. `HDMI-A-1`, `eDP-1`. `auto` = first connected output |
| `playback.display.drmMode` | `auto` | e.g. `1920x1080`. `auto` = the screen's preferred mode |
| `playback.display.keepAspect` | `true` | `false` stretches content to fill the screen |
| `location.gpsEnabled` | `true` | Read GNSS from a Quectel modem |
| `modem.atPort` | `auto` | `auto` probes known AT ports unless ModemManager is running; a device path forces that port; `none` never opens one |
| `health.heartbeatIntervalSeconds` | 300 | Overridden by the CMS setting when the server sends one (clamped 60..3600) |
| `health.maxLogQueueMb` | 50 | Cap on unsent playback log; the oldest entries are dropped beyond it (logged in `health.log`) |

Connected outputs as the kernel sees them: `grep . /sys/class/drm/card*-*/status`; they are also
reported in the heartbeat (`display`).

## Install a new cab

From a checkout or release of this directory, on the box:

```sh
sudo ./bootstrap.sh <SERIAL_NUMBER> <API_TOKEN> [API_BASE_URL]
```

This installs `mpv`, `python3-requests`, `python3-psutil` (and the GPIO library on a Pi), creates
user `orison` and adds it to the `video`, `render`, `audio`, `dialout`, `gpio` and `input` groups
that exist, installs the code and units, writes `config.json` only if there is none, and starts
the services. It is safe to re-run. Optionally copy a fallback video to
`/opt/orison/content/fallback/orison_fallback.mp4`.

## Update and roll back

```sh
sudo ./update.sh <release .tar.gz URL | .tar.gz file | unpacked directory>
sudo /opt/orison/update.sh --rollback
```

Run the `update.sh` from the NEW release (firmware before 1.2.0 shipped an `update.sh` that copied
everything, including tests and any stray `config.json`; do not use it). The release can be a
tarball of the repository or of `device/`. The update checks that the code parses, backs up the
installed firmware to `/opt/orison/releases/` (newest three kept), installs only the runtime
files, reloads systemd, restarts the services and checks that they stay up for about a minute;
if not, it restores the backup by itself. `config.json`, `content/`, `logs/` and `runtime/` are
never touched. `--rollback` restores the most recent backup.

## Logs and state

| Where | What |
|---|---|
| `journalctl -u orison-player -u orison-sync -u orison-health` | Everything the services print |
| `/opt/orison/logs/{player,sync,health}.log` | Same, rotated at 5 MB x 3 |
| `/opt/orison/logs/playback.jsonl` | Playback entries not yet handed to the uploader |
| `/opt/orison/logs/outbox/*.jsonl` | Playback entries waiting to be sent (segments of 200) |
| `/opt/orison/logs/playback.dead.jsonl` | Entries the server rejected (last 1000), with the reason |
| `/opt/orison/logs/playback.queue.json` | Counters: entries dropped by the size cap, dead-lettered |
| `/opt/orison/runtime/player_state.json` | Player status, state, trigger, last error, mpv output, connected displays |
| `/opt/orison/runtime/sync_status.json` | Sync state, last error, backoff per failing loop |
| `/opt/orison/runtime/server_config.json` | Intervals adopted from the CMS |
| `/opt/orison/content/{current,previous,cache}` | Live content, the one before (rollback/reuse), reuse cache |

Playback entries are written when an item leaves the screen, with the measured `durationMs`;
`completedFull` is true only if it ran to within 500 ms of its scheduled length.

## After an update, check on the box

1. `cat /opt/orison/VERSION` shows the new version; `systemctl status 'orison-*'` all active, and
   `systemctl show -p NRestarts orison-player` does not climb.
2. `journalctl -u orison-player -n 50`: the `player started: trigger=...` line shows the expected
   trigger and the connected display; no repeated `mpv exited` lines.
3. The screen shows the safety message then the loop (`always`), or the slot stills (`gpio`).
4. `cat /opt/orison/runtime/sync_status.json`: `"state": "ok"`.
5. `ls /opt/orison/logs/outbox/` empties within a heartbeat or two; `playback.dead.jsonl` is empty
   or explains itself.
6. In the CMS the cab is online with the new firmware version and the expected loop.
