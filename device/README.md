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

## Loop manifests

The player takes the loop's timing from the manifest the sync agent downloaded
(`content/current/manifest.json`). Two formats are on cabs:

- **`formatVersion: 2`** (loops published by the CMS's loop compiler from release 1.2.0 on). Items
  start at `contents[].absoluteStartMs` and last `durationMs`; slots are `slotDurationMs` long
  (`slots[].startMs` / `durationMs`); `totalDurationMs` is measured from the compiled file and is
  where the loop wraps. Every slot has a `staticImageUrl`; slots without a still image of their own
  share one branded still with `staticImageAssetId: null`, downloaded once and logged as a
  `STATIC_IMAGE` with no `assetId`. A pre-built (uploaded) loop has `slotCount: 0`, no slots and
  `slotDurationMs: null`: the whole video is one `LOOP_VIDEO` item. `fit`, `sourceDurationMs` and
  `video` are informational; the player does not need them.
- **No `formatVersion`** (every loop published before that release, until someone republishes it).
  Slot p starts at p x `totalDurationMs` / slot count and an item at its slot start + `startTimeMs`.
  `totalDurationMs` was a constant 600000 there, while the old compiler's files could be longer, so
  the player checks the file's real length with mpv once and wraps where the file ends (the
  untimed tail is not logged).

Republishing: when nothing changed the CMS keeps the same manifest checksum, so the cab does
nothing at all. When only the manifest changed (a still, the name, the safety message in the
file) the cab downloads the manifest and reuses the video it has (matched by
`compiledVideoChecksum`); if the video and item timing are the same, the loop on screen carries on
without a restart.

## Configuration: `/opt/orison/config.json`

Only `device.*` is required. Keys that are missing take the default below; keys from older
firmware that are no longer read (`device.cdnBaseUrl`, `playback.loopContinuously`,
`playback.screenResolution`, `health.logUploadIntervalSeconds`, `health.maxLogRetentionDays`)
are ignored. `config.json.template` lists every key.

| Key | Default | Meaning |
|---|---|---|
| `device.serialNumber` | required | Cab serial as registered in the CMS |
| `device.apiBaseUrl` | required | The CMS's address followed by `/api`, e.g. `https://<CMS host>/api` |
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
sudo ./bootstrap.sh <SERIAL_NUMBER> <API_TOKEN> <API_BASE_URL>
```

`API_BASE_URL` is required for a new cab (there is no default address).

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

## What the cab and the CMS exchange

The contract is `DEVICE_CONTRACT_V2` (firmware 1.2.0); every new field is optional both ways, so
1.2.0 works with an older CMS and 1.0.0/1.1.0 cabs work with the current one.

| Call | The cab sends | The cab uses from the answer |
|---|---|---|
| `POST /api/devices/heartbeat` (every `heartbeatIntervalSeconds`, and right after an activation) | status, `playerStatus` (`error` when the player's state file is stale), `playerState`, `playbackTrigger`, signal (`signalStrength` only as dBm, `signalPercent` as 0-100), detected `networkType`, `safetyChecksum`, `sync` (state, error, failed loop, since, last synced, next retry), location | `expectedLoopId` / `expectedChecksum` / `disabled` / `expectedSafetyChecksum`: any difference from what is installed asks the sync agent to sync now (at most every 2 minutes); `config` intervals (clamped) |
| `GET /api/devices/manifest` (every `syncIntervalSeconds`, or on request) | | loop id, manifest checksum and URL, pause flag; `safetyVideo` when present (null = remove it), else the copy in the manifest file. 404 = nothing assigned (checked again after 5 minutes, then less often) |
| `POST /api/devices/playback-log` (with each heartbeat, segments of 200) | entries with `eventId`, `loopId` (the loop on screen), measured `durationMs`, `completedFull`, `mode` (`journey`, `continuous`, `idle`, `silent`), stills as `type: STATIC_IMAGE` with `contentType: null` | 2xx: the segment is removed (entries listed in `rejected` go to `playback.dead.jsonl`); 400/413/422: retried once with `continuous` sent as `journey` (older CMS), then dead-lettered; anything else: kept and retried with backoff |

The CMS skips entries whose `eventId` it already stored for the cab, so a batch re-sent after a
lost response is not counted twice; it treats an `eventId` as the mark of a measured entry.
Entries that firmware 1.0.0/1.1.0 left unsent in `playback.jsonl` are sent once after the update
without an `eventId` (their durations and completion were never measured), with the stills that
old firmware logged as adverts rewritten to `STATIC_IMAGE`.

How the CMS counts these rows for advertisers is in `apps/web/src/lib/playback-metrics.ts`.

## Tests

- `python3 -m unittest discover -s tests` (from `device/`): the services against a fake mpv,
  fake clock and local HTTP servers.
- `apps/web/e2e/billing.e2e.py`: the billing path end to end against a running CMS (real upload,
  compile, publish, sync, player, upload, analytics and CSV export), including firmware 1.0.0
  from git history. See the file's header for how to run it.
- `scripts/demo/simulate-cab.py`: one simulated cab (real services, fake modem and mpv) driven
  through the phone app's actions.

`scripts/demo/mac-demo-player.py` is a separate player for showing a loop on a Mac. It is not part
of the firmware and is never installed on a cab (it used to be `device/demo.py`).

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
