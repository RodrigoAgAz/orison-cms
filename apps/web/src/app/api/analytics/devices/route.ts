import { prisma } from "@orison/db";

import { requireApiUser } from "@/lib/auth";
import { publicDevice } from "@/lib/device-public";
import { apiError, apiResponse } from "@/lib/http";

export async function GET() {
  try {
    await requireApiUser();
    const devices = await prisma.device.findMany({
      orderBy: { serialNumber: "asc" },
      include: {
        heartbeats: {
          orderBy: { receivedAt: "desc" },
          take: 20,
        },
      },
    });

    return apiResponse(devices.map(publicDevice));
  } catch (error) {
    return apiError(error);
  }
}

