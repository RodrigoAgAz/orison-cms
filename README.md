# Orison CMS

Orison runs advertising screens in the back of London black cabs. This repository is everything
that decides what those screens play:

- **The desktop CMS** (`apps/web`, pages at `/`): for the people who run the screens. Upload adverts
  and fillers, build loops, publish them, choose which cabs play them, pause cabs, and read what
  was played.
- **The phone app** (`apps/web`, pages at `/m`): for non-technical staff on an iPhone. See the
  cabs on a list and a map, change what a cab or group plays, upload a finished video, pause or
  resume a cab. Phones that open the site root are sent to `/m`.
- **The cab software** (`device/`): Python services on the small x86 Linux box in each cab, which
  download what the CMS assigns, play it with mpv, and report heartbeats and a playback log.
  Everything about the cab is in [`device/README.md`](device/README.md).

One Next.js process does all the server work, including the media work (ffmpeg): there is no
worker and no Redis. Data lives in PostgreSQL; video and image files in S3-compatible object
storage. Production runs on Railway from the `Dockerfile`.

## What the product does

- A **loop** is what a cab's screen plays. Normally it is ten one-minute **slots** built in the
  loop builder: each slot is an advert followed by fillers and must add up to exactly 60 s to
  publish. Publishing compiles the loop into one MP4 (30 fps, H.264, AAC stereo 48 kHz, keyframe
  every 2 s and at every item start; picture size from Settings > Screen format, default 1280x800)
  plus a manifest the cab uses to log what it played. A **pre-built loop** is one finished video
  uploaded as it is (desktop Loops page, or the phone app), converted to the same format.
- A passenger **journey** (button/door input on cabs that have it) plays the safety message, then
  the loop. Between journeys the screen shows a still. A cab without passenger inputs (like the
  pilot cab) plays continuously.
- **Where a loop plays**: a cab's own choice beats its group's, which beats "all cabs"; within each,
  the most recent action wins (a desktop publish or an explicit assignment). Changing where a loop
  that is on air plays is confirmed and logged, a group a loop is on air for cannot be deleted, and
  Pause says what will play instead.
- **Publishing runs in the background**. A loop on air stays on air in its previous version until
  the new one is ready; unchanged content is not recompiled; an interrupted publish is detected and
  can be retried. Superseded files are deleted 6 hours later; deleting a loop deletes its files.
- **Assets**: adverts, fillers, stills and the safety message. iPhone HDR / 10-bit / 4:2:2 video is
  accepted; library copies are kept up to 1920x1080. An asset a loop uses is hidden from the
  library rather than deleted; the configured safety message cannot be removed.
- **Cabs** report a heartbeat every few minutes (state of the player, update progress, signal,
  position from GPS or the mobile mast). A cab is shown offline after 3 missed heartbeats (never
  less than 10 minutes).

## Running it locally

Needs Node 22 (the image uses 22.23.4), PostgreSQL, and `ffmpeg`/`ffprobe` on the PATH (Ubuntu
24.04's ffmpeg 6.1 is what production runs; publishing and media processing need it).

```bash
npm ci
cp .env.example .env            # then set DATABASE_URL (and nothing else, for local use)
set -a && . ./.env && set +a    # the npm scripts read the environment, not .env
npm run db:generate             # Prisma client
npm run db:push                 # apply the schema
npm run db:seed                 # first admin: DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD
npm run dev                     # http://localhost:3000
```

Without S3 settings, files are stored under `apps/web/tmp/storage` and served by the app itself.

Optional demo data: `npm run demo:seed` builds a demo fleet (8 cabs `DEMO-CAB-01..08`, 2 groups,
pre-built loops and a ten-slot loop, a day of heartbeats and playback log) in the local database;
`npm run demo:heartbeat` keeps the demo cabs online; `python3 scripts/demo/simulate-cab.py` runs the
real cab software against the local server with a fake modem and player.

## Testing

| Command | What it covers | Needs |
|---|---|---|
| `npm run typecheck` | TypeScript in `packages/shared`, `packages/db`, `apps/web` | `npm run db:generate` first |
| `npm test` | Web unit tests (`apps/web/test/*.test.ts`): routing, slot rules, uploads in pieces, the middleware matcher, playback metrics, ... | Nothing else (no database, browser or ffmpeg) |
| `npm run test:device` | Cab software unit tests (`device/tests`) | Python 3 with `requests` and `psutil` |
| `npm run test:e2e:desktop` | The desktop as staff use it, in Chromium: asset uploads (HDR iPhone clip included), the loop builder, publish, where it plays, pause, delete; uploads in pieces for both desktop flows, with a piece cut off and a page closed mid-upload | A running server (`BASE_URL`, default `http://localhost:3000`), `DATABASE_URL` and `psql` (to remove its test cab), `ffmpeg`, Playwright's Chromium. Creates everything under a unique `E2E-LOOPS-...` prefix and removes it, also after a failure |
| `npm run test:e2e:mobile` | The phone app in iPhone emulation, checked against what a cab is actually told | The demo data, `ffmpeg`, Chromium. **Reseeds the demo data and starts extra dev servers**: give it its own database and server (see the top of `apps/web/e2e/mobile.e2e.mjs` and its `E2E_*` options) |
| `python3 apps/web/e2e/billing.e2e.py` | The billing path end to end: real cab software plays scripted journeys, then plays are recomputed and compared with the stored rows, analytics and the CSV export | A running server, `DATABASE_URL`, `psql`, `ffmpeg`, Python with `requests` and `psutil` |

CI (`.github/workflows/ci.yml`) runs only typecheck, `npm test` and `npm run test:device`, which
need no browser, database or server. Run the end-to-end suites by hand before a release.

## Deploying (Railway)

Railway builds the `Dockerfile` from the repository on every push to the deployed branch:

1. **Build** (a few minutes): Ubuntu 24.04 with Ubuntu's ffmpeg 6.1.1 and Node 22.23.4 (official
   tarball, checked against its published sha256); `npm ci`; `prisma generate`; `next build`; dev
   dependencies removed.
2. **Pre-deploy** (configured in Railway, not in this repo): `npx tsx packages/db/prisma/seed.ts`.
   It runs before the new schema is applied, so it only uses columns that exist in every release,
   skips cleanly when the tables do not exist yet (first deploy), and only creates the first admin
   if missing. Keep that path working.
3. **Start** (the image's `CMD`): `prisma db push` applies the schema (additive changes only), the
   seed runs again (creates the admin on a brand-new database), then `next start` on port 3000
   with `apps/web/scripts/server-timeouts.cjs` preloaded.
4. Railway health-checks `GET /login` and then switches traffic to the new container.

On start the server also removes leftover upload temp folders and abandoned uploads, fills in the
latest cab state where needed, and schedules the daily retention job.

Media jobs (asset processing, loop compiles, uploads) run one at a time inside the web process.
A deploy or restart interrupts any that are running: an interrupted publish shows as interrupted
and can be published again; an upload being converted is marked "Processing was interrupted" and
must be uploaded again; upload pieces are kept on the container's disk, so a deploy loses uploads
that were half sent (the browser or phone starts that file again by itself).

## Environment variables

[`.env.example`](.env.example) lists every variable the app reads, with a one-line explanation.
In production the ones that matter are `DATABASE_URL`, `SESSION_SECRET`, `APP_URL`,
`DEVICE_SHARED_TOKEN`, the storage settings (`S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT`, `S3_FORCE_PATH_STYLE`), and `DEFAULT_ADMIN_EMAIL` /
`DEFAULT_ADMIN_PASSWORD` for a brand-new database. Everything else has a sensible default.

## Operating it (the facts you need on a bad day)

**Releases are roll-forward only.** The container applies the schema with `prisma db push` on start;
a previous image refuses to start against a newer schema. If a release is wrong, fix it and deploy
again; do not redeploy an older image.

**What needs a loop to be published again** (a cab only gets these with a new publish):

- a change of Settings > Screen format (loops on air keep the size they were compiled at);
- a changed safety message, for cabs on firmware older than 1.2.0 (1.2.0+ get the current one
  with every check);
- loops published before the current loop compiler (exact slot timings, sound handling, smaller
  files, the shared logo still): they keep playing as they are until republished;
- any edit in the builder ("Changes not yet published" until then).

Changing where a loop plays, pausing, resuming and check-in intervals (Settings, for firmware
1.2.0+) need no publish: cabs pick them up at their next heartbeat. Cabs on firmware older than
1.1.0 only look for a new loop every 30 minutes.

**Uploads.** Files up to 500 MB. Pre-built loops and phone videos: MP4, MOV or M4V, up to 14
minutes. Assets: MP4, MOV, M4V or WebM video, or a JPG, PNG or WebP image.
Every upload, desktop and phone, goes up in 4 MB pieces: Railway's proxy cuts off a request body
that takes more than 5 minutes, so a single-request upload of a large file fails in production
whatever the app allows. A piece that fails is retried by itself; a page or app closed mid-upload
carries on when the same file is chosen again (pieces are kept for a day). Once all pieces are
there, the file is converted in the background and the page shows its progress.

**The phone app is open without sign-in** (owner's decision): anyone who has the address can see the
cabs and change what plays. Their actions are logged as "Phone app (not signed in)" with the
request's IP; uploads without sign-in are capped (`PHONE_APP_ANON_UPLOADS_PER_HOUR`, default 20 an
hour in total). Team management, password changes and the whole desktop site always need sign-in.
**To require sign-in on the phone app again, set `PHONE_APP_REQUIRE_SIGN_IN=true` in Railway and
restart**; no code change or rebuild. Search engines are told not to index any of the site.

**Advert plays** (dashboard, analytics, CSV export) count video adverts that played to a passenger
(a journey) or on a cab playing continuously. Never counted as advert plays: stills (counted
separately as "still showings"), the safety message, journey markers, and full passes of a
pre-built loop (counted as "pre-built loop passes": the CMS does not know which adverts are inside
such a video). Advert completion is only reported for entries firmware 1.2.0+ measured; otherwise
it says "Not measured". Days and times are London time.

**Retention.** Heartbeats are deleted after `HEARTBEAT_RETENTION_DAYS` (default 90, minimum 30).
Playback logs, which advertisers are billed from, are kept forever unless
`PLAYBACK_LOG_RETENTION_DAYS` is set (minimum 30). The job runs daily in the web process.

**Pausing.** "Pause all cabs" (Cabs page) stops every screen at its next heartbeat; a single cab can
be paused from the Cabs page or the phone app. Pausing a loop takes it off air and the confirmation
says what each cab will play instead.

**Where to look.** Railway's deploy logs show the seed and `db push`; the service logs show media
job failures (the CMS shows a short reason and puts the detail in the log). The dashboard lists
cabs that need attention (offline, failing to update, not on the expected loop).

## Repository layout

```
apps/web/                Next.js 14 app: desktop CMS, phone app (/m), API routes, media work
  src/app/api/devices/   what the cabs call: heartbeat, manifest, playback log
  src/app/api/uploads/   desktop uploads in pieces (assets and pre-built loops)
  src/app/api/m/         the phone app's API (its uploads under /api/m/uploads)
  src/lib/               routing, loop compiler, publishing, media, storage, uploads in pieces
  src/middleware.ts      sign-in check for pages and API routes (see the comment on its matcher)
  e2e/                   end-to-end suites (see Testing)
  test/                  unit tests (npm test)
packages/db/             Prisma schema, client and the seed
packages/shared/         zod schemas and constants shared by the app and the seed
device/                  the cab software (device/README.md)
scripts/demo/            demo fleet and simulated cab, for local use only
Dockerfile               the production image Railway builds
```
