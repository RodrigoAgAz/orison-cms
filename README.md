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

## Operational Notes

- The pilot uses a single compiled loop file for simpler device playback.
- Manifest metadata is still generated and stored so the device can validate and log proof-of-play against slot boundaries.
- Local storage is supported for development through `/api/storage/*`; production should use S3-compatible storage plus a CDN.
- Device auth supports a shared bearer token via `DEVICE_SHARED_TOKEN`, and the schema also allows per-device token hashes.
