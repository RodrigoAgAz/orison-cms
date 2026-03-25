import { prisma } from "@orison/db";

import { apiError, apiResponse } from "@/lib/http";

export async function GET() {
  try {
    const devices = await prisma.device.findMany({
      orderBy: { serialNumber: "asc" },
      include: {
        heartbeats: {
          orderBy: { receivedAt: "desc" },
          take: 20,
        },
      },
    });

    return apiResponse(devices);
  } catch (error) {
    return apiError(error);
  }
}

