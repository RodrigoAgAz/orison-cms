import { prisma, Prisma } from "@orison/db";

import { requireApiUser } from "@/lib/auth";
import { apiError, ApiError } from "@/lib/http";
import { addDaysToKey, formatLondonCsvTime, isDayKey, londonDayKey, londonDayStart } from "@/lib/london-time";
import { KIND_LABELS, playbackKindSql, type PlaybackKind } from "@/lib/playback-metrics";

export const dynamic = "force-dynamic";

// Rows are read in pages of this size by keyset pagination on ("playedAt", id) and written out as
// they arrive, so memory stays flat whatever the range (the old export built the whole file in
// memory: 7 days took 3.2 GB and 30 days was killed, taking the cab endpoints down with it).
const BATCH_SIZE = 5000;
const MAX_DAYS = 366;

const HEADER = [
  "playedAtUtc",
  "playedAtLondon",
  "londonDate",
  "cabSerial",
  "cabLicenceNumber",
  "countsAs",
  "loopId",
  "loopName",
  "slotPosition",
  "contentType",
  "playbackType",
  "eventName",
  "assetId",
  "assetFilename",
  "mode",
  "playerState",
  "measured",
  "completedFull",
  "durationMs",
  "journeyId",
  "eventId",
  "journeyLocation",
];

type ExportRow = {
  id: string;
  playedAt: Date;
  serialNumber: string;
  cabLicenseNumber: string | null;
  kind: PlaybackKind;
  loopId: string;
  loopName: string | null;
  slotPosition: number | null;
  contentType: string | null;
  playbackType: string | null;
  eventName: string | null;
  assetId: string | null;
  assetFilename: string | null;
  mode: string | null;
  playerState: string | null;
  completedFull: boolean;
  durationMs: number | null;
  journeyId: string | null;
  eventId: string | null;
  journeyLocation: unknown;
};

function csvCell(value: string | number | boolean | null | undefined) {
  const raw = value == null ? "" : String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function csvLine(row: ExportRow) {
  const measured = Boolean(row.eventId);
  return [
    row.playedAt.toISOString(),
    formatLondonCsvTime(row.playedAt),
    londonDayKey(row.playedAt),
    row.serialNumber,
    row.cabLicenseNumber,
    KIND_LABELS[row.kind] ?? row.kind,
    row.loopId,
    row.loopName,
    row.slotPosition,
    row.contentType,
    row.playbackType,
    row.eventName,
    row.assetId,
    row.assetFilename,
    row.mode,
    row.playerState,
    measured ? "yes" : "no",
    // Firmware before 1.2.0 marks every play complete when it starts: not a measurement.
    measured ? row.completedFull : null,
    row.durationMs,
    row.journeyId,
    row.eventId,
    row.journeyLocation ? JSON.stringify(row.journeyLocation) : null,
  ]
    .map(csvCell)
    .join(",");
}

function fetchBatch(from: Date, to: Date, after: { playedAt: Date; id: string } | null) {
  const cursor = after ? Prisma.sql`AND (p."playedAt", p.id) > (${after.playedAt}, ${after.id})` : Prisma.empty;
  return prisma.$queryRaw<ExportRow[]>`
    SELECT p.id, p."playedAt", d."serialNumber", d."cabLicenseNumber",
           ${Prisma.raw(playbackKindSql("p"))} AS kind,
           p."loopId",
           CASE WHEN p."loopId" = 'fallback' THEN 'Standby video (built into the cab)' ELSE l.name END AS "loopName", p."slotPosition", p."contentType"::text AS "contentType",
           p."playbackType", p."eventName", p."assetId", a.filename AS "assetFilename", p.mode, p."playerState",
           p."completedFull", p."durationMs", p."journeyId", p."eventId",
           CASE WHEN p."eventName" IN ('JOURNEY_START', 'JOURNEY_END') THEN p."locationData" END AS "journeyLocation"
    FROM "PlaybackLog" p
    JOIN "Device" d ON d.id = p."deviceId"
    LEFT JOIN "Asset" a ON a.id = p."assetId"
    LEFT JOIN "Loop" l ON l.id = p."loopId"
    WHERE p."playedAt" >= ${from} AND p."playedAt" < ${to} ${cursor}
    ORDER BY p."playedAt", p.id
    LIMIT ${BATCH_SIZE}
  `;
}

/** from/to are London calendar dates (yyyy-mm-dd), both included. */
async function parseRange(request: Request) {
  await requireApiUser();
  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!from || !to) {
    throw new ApiError("Both from and to dates are required", 400);
  }
  if (!isDayKey(from) || !isDayKey(to)) {
    throw new ApiError("Dates must look like 2026-11-17", 400);
  }
  if (to < from) {
    throw new ApiError("The last day is before the first day", 400);
  }
  if (addDaysToKey(from, MAX_DAYS - 1) < to) {
    throw new ApiError(`Export at most ${MAX_DAYS} days at a time`, 400);
  }
  return { from, to, start: londonDayStart(from), end: londonDayStart(addDaysToKey(to, 1)) };
}

function headers(from: string, to: string) {
  return {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="orison-playback-${from}-to-${to}.csv"`,
    "Cache-Control": "no-store",
  };
}

export async function HEAD(request: Request) {
  try {
    const range = await parseRange(request);
    return new Response(null, { headers: headers(range.from, range.to) });
  } catch (error) {
    const response = apiError(error);
    return new Response(null, { status: response.status });
  }
}

export async function GET(request: Request) {
  try {
    const range = await parseRange(request);
    const encoder = new TextEncoder();
    let cursor: { playedAt: Date; id: string } | null = null;
    let headerSent = false;
    let done = false;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (!headerSent) {
            headerSent = true;
            controller.enqueue(encoder.encode(`${HEADER.join(",")}\n`));
            return;
          }
          if (done) {
            controller.close();
            return;
          }
          const rows = await fetchBatch(range.start, range.end, cursor);
          if (rows.length < BATCH_SIZE) {
            done = true;
          }
          if (rows.length > 0) {
            const last = rows[rows.length - 1];
            cursor = { playedAt: last.playedAt, id: last.id };
            controller.enqueue(encoder.encode(`${rows.map(csvLine).join("\n")}\n`));
          } else {
            controller.close();
          }
        } catch (error) {
          console.error("playback export failed", error);
          controller.error(error);
        }
      },
    });

    return new Response(stream, { headers: headers(range.from, range.to) });
  } catch (error) {
    return apiError(error);
  }
}
