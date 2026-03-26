import { endOfDay, startOfDay } from "date-fns";

import { prisma } from "@orison/db";

import { apiError, ApiError } from "@/lib/http";

function csvCell(value: string | number | boolean | null) {
  const raw = value == null ? "" : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");

    if (!from || !to) {
      throw new ApiError("Both from and to dates are required", 400);
    }

    const fromDate = startOfDay(new Date(`${from}T00:00:00`));
    const toDate = endOfDay(new Date(`${to}T00:00:00`));

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new ApiError("Invalid export date range", 400);
    }

    const logs = await prisma.playbackLog.findMany({
      where: {
        playedAt: {
          gte: fromDate,
          lte: toDate,
        },
      },
      orderBy: {
        playedAt: "asc",
      },
      include: {
        device: true,
      },
    });

    const assetIds = Array.from(
      new Set(logs.map((log) => log.assetId).filter((assetId): assetId is string => Boolean(assetId))),
    );
    const assets = assetIds.length
      ? await prisma.asset.findMany({
          where: {
            id: {
              in: assetIds,
            },
          },
        })
      : [];
    const assetMap = new Map(assets.map((asset) => [asset.id, asset.filename]));

    const rows = [
      [
        "playedAt",
        "deviceSerial",
        "cabLicenseNumber",
        "loopId",
        "slotPosition",
        "contentType",
        "playbackType",
        "eventName",
        "assetId",
        "assetFilename",
        "mode",
        "playerState",
        "completedFull",
        "durationMs",
        "journeyId",
        "locationData",
      ].join(","),
      ...logs.map((log) =>
        [
          csvCell(log.playedAt.toISOString()),
          csvCell(log.device.serialNumber),
          csvCell(log.device.cabLicenseNumber),
          csvCell(log.loopId),
          csvCell(log.slotPosition),
          csvCell(log.contentType),
          csvCell(log.playbackType),
          csvCell(log.eventName),
          csvCell(log.assetId),
          csvCell(log.assetId ? assetMap.get(log.assetId) ?? log.assetId : null),
          csvCell(log.mode),
          csvCell(log.playerState),
          csvCell(log.completedFull),
          csvCell(log.durationMs),
          csvCell(log.journeyId),
          csvCell(log.locationData ? JSON.stringify(log.locationData) : null),
        ].join(","),
      ),
    ];

    return new Response(rows.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orison-playback-${from}-to-${to}.csv"`,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
