# Orison Screens CMS

Monorepo for the Orison Screens pilot fleet:

- `apps/web`: Next.js 14 dashboard and `/api/*` surface
- `apps/worker`: BullMQ worker for async media processing and loop publishing
- `packages/db`: Prisma schema, client, and seed script
- `packages/shared`: shared constants, schemas, and manifest helpers
- `device`: Raspberry Pi sync, playback, and health services

## What This Build Includes

- Prisma schema for users, assets, loops, slots, devices, heartbeats, playback logs, activity events, and settings
- CMS pages for dashboard, loop library, loop builder, assets, devices, analytics, and settings
- API routes for auth, assets, loops, slots, devices, analytics, settings, and local storage serving
- Media-processing helpers for upload handling, ffmpeg-based normalization, and single-file loop compilation
- BullMQ worker scaffold for queued asset processing and loop publishing
- Raspberry Pi services for sync, playback, heartbeat reporting, and playback-log upload
- Dockerfile and Docker Compose for app, worker, Postgres, and Redis

## Quick Start

1. Copy `.env.example` to `.env`.
2. Install dependencies:

```bash
npm install
```

3. Generate Prisma client and push the schema:

```bash
npm run db:generate
npm run db:push
npm run db:seed
```

4. Start the web app:

```bash
npm run dev:web
```

5. Optional: start the async worker in another shell:

```bash
npm run dev:worker
```

Default seeded login:

- Email: `admin@orisonscreens.com`
- Password: `ChangeMe123!`

Override both with `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD`.

## Docker

```bash
docker compose up --build
```

Services:

- `app`: Next.js CMS/API
- `worker`: BullMQ worker
- `db`: PostgreSQL 16
- `redis`: Redis 7

## Media Pipeline Notes

- Uploads are processed inline by default when `INLINE_MEDIA_JOBS=true`.
- Set `INLINE_MEDIA_JOBS=false` and run the worker for queue-based processing.
- `ffmpeg` and `ffprobe` are required for proper video normalization, thumbnails, and loop compilation.
- Without `ffmpeg`, the web app can still store uploaded assets, but compiled loop publishing will not work.

## Device Provisioning

Device code is under [`device/`](/Users/rodrigoagag/Desktop/CMS/device).

Important files:

- [`device/sync_agent.py`](/Users/rodrigoagag/Desktop/CMS/device/sync_agent.py)
- [`device/player_manager.py`](/Users/rodrigoagag/Desktop/CMS/device/player_manager.py)
- [`device/health_monitor.py`](/Users/rodrigoagag/Desktop/CMS/device/health_monitor.py)
- [`device/bootstrap.sh`](/Users/rodrigoagag/Desktop/CMS/device/bootstrap.sh)
- [`device/systemd/orison-sync.service`](/Users/rodrigoagag/Desktop/CMS/device/systemd/orison-sync.service)

Provisioning flow:

1. Install the Raspberry Pi base packages from the spec.
2. Copy the `device/` directory onto the Pi.
3. Run:

```bash
./bootstrap.sh ORISON-P1-001 your-device-token
```

4. Place fallback media at `/opt/orison/content/fallback/orison_fallback.mp4`.
5. Enable and start the systemd services.

## Deploying and rolling back

This release (phone app at `/m`, per-cab content, cab locations, firmware 1.1.0) is **roll-forward only**.
It adds columns, a table and enum values that the container applies with `prisma db push` on start. The
previous image's `prisma db push` would refuse to drop them, so that container would not start; forcing it
(`--accept-data-loss`) would also make the old routing play the newest library upload on every cab. If
something is wrong after deploying, fix forward.

Deploying does not change what any existing cab is served. On data that predates explicit assignments
the resolver picks loops exactly as the previous one did, including published loops with no
`publishedAt` (still treated as newest) and published loops with no `manifestUrl` (their cabs are still
served nothing and keep what they have). `apps/web/test/routing.test.ts` checks this against the previous
algorithm. To see whether you have any such loops, which is worth cleaning up either way:

```sql
SELECT id, name FROM "Loop" WHERE status='PUBLISHED' AND ("publishedAt" IS NULL OR "manifestUrl" IS NULL);
```

New environment variables (all optional):

- `REQUEST_TIMEOUT_SECONDS` (default `1800`): how long a request body may take to arrive, for phone
  uploads over mobile data. Set by `apps/web/scripts/server-timeouts.cjs`, which `npm run start` (the
  Docker `CMD`) preloads. The proxy in front of the app must allow at least as long, or it cuts the
  upload off first.
- `OPENCELLID_API_KEY`, `CELL_LOOKUP_DISABLE_PUBLIC`, `CELL_LOOKUP_BEACONDB_URL`, `CELL_LOOKUP_TIMEOUT_MS`,
  `CELL_LOOKUP_USER_AGENT`: cell-tower lookup for cabs without a GPS fix (see `.env.example`).

Behaviour changes to expect:

- The desktop site now shows a cab as offline after 3 missed heartbeats (15 minutes with the default
  5-minute heartbeat, never less than 10 minutes) instead of after an hour.
- Cabs on firmware before 1.1.0 (every cab in the field at deploy time) only pick up changes every
  30 minutes; the phone app says so. After the firmware update they change within one heartbeat.
- Signing in now lasts 30 days. Changing a password, an admin password reset, a role change or deleting
  a user signs that person out everywhere (the person changing their own password stays signed in on
  that device).

Firmware rollout (cab Raspberry Pis, `device/`):

1. Test on one cab first. Package `device/` as a tarball, then on that Pi run
   `./update.sh <tarball URL>` (stops the services, copies the files including `VERSION`, starts them).
2. Fit the GNSS antenna to the modem's GNSS port. Without it the cab still works and reports an
   approximate position from the mobile mast. GPS is on unless `location.gpsEnabled` is `false` in
   `/opt/orison/config.json`; older config files without that section are fine.
3. Check that cab in the phone app: software version `1.1.0` under Technical details, a GPS position,
   and that a change of video reaches it within about 5 minutes. Then update the rest.

Installing the phone app on an iPhone: open the site in **Safari** (phones are sent to `/m`), sign in, tap
**Share**, then **Add to Home Screen**. It then opens full screen like an app. Each person signs in with
their own account; admins add teammates under Account > Team.

## Operational Notes

- The pilot uses a single compiled loop file for simpler device playback.
- Manifest metadata is still generated and stored so the device can validate and log proof-of-play against slot boundaries.
- Local storage is supported for development through `/api/storage/*`; production should use S3-compatible storage plus a CDN.
- Device auth supports a shared bearer token via `DEVICE_SHARED_TOKEN`, and the schema also allows per-device token hashes.
