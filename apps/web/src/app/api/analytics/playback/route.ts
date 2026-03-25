import { prisma } from "@orison/db";
import { subDays } from "date-fns";

import { apiError, apiResponse } from "@/lib/http";

export async function GET() {
  try {
    const since = subDays(new Date(), 30);
    const [slotCounts, adCounts] = await Promise.all([
      prisma.playbackLog.groupBy({
        by: ["slotPosition"],
        where: {
          playedAt: {
            gte: since,
          },
        },
        _count: true,
      }),
      prisma.playbackLog.groupBy({
        by: ["assetId"],
        where: {
          playedAt: {
            gte: since,
          },
          contentType: "ADVERTISEMENT",
        },
        _count: true,
      }),
    ]);

    return apiResponse({
      slotCounts,
      adCounts,
    });
  } catch (error) {
    return apiError(error);
  }
}

