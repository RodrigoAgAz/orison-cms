import { prisma } from "@orison/db";
import { deviceRegistrationSchema } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { publicDevice } from "@/lib/device-public";
import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

export async function POST(request: Request) {
  try {
    await requireApiUser();
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

    return apiResponse(publicDevice(device), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
