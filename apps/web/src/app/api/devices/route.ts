import { prisma } from "@orison/db";
import { deviceRegistrationSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

export async function GET() {
  try {
    const devices = await prisma.device.findMany({
      orderBy: { serialNumber: "asc" },
      include: {
        heartbeats: {
          orderBy: { receivedAt: "desc" },
          take: 10,
        },
      },
    });

    return apiResponse(devices);
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, deviceRegistrationSchema);
    const device = await prisma.device.upsert({
      where: { serialNumber: body.serialNumber },
      update: {
        cabLicenseNumber: body.cabLicenseNumber,
        driverName: body.driverName,
        hpTaxiCabId: body.hpTaxiCabId,
        notes: body.notes,
        isActive: true,
      },
      create: {
        serialNumber: body.serialNumber,
        cabLicenseNumber: body.cabLicenseNumber,
        driverName: body.driverName,
        hpTaxiCabId: body.hpTaxiCabId,
        notes: body.notes,
      },
    });

    await logActivity("DEVICE_REGISTERED", `Device ${device.serialNumber} registered`, {
      deviceId: device.id,
      serialNumber: device.serialNumber,
    });

    return apiResponse(device, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}

