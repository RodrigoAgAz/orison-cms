import { prisma } from "@orison/db";
import { deviceRegistrationSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

function parsePageParam(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const page = parsePageParam(url.searchParams.get("page"), 1);
    const pageSize = parsePageParam(url.searchParams.get("pageSize"), 25);
    const [devices, total] = await Promise.all([
      prisma.device.findMany({
        orderBy: { serialNumber: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          heartbeats: {
            orderBy: { receivedAt: "desc" },
            take: 10,
          },
        },
      }),
      prisma.device.count(),
    ]);

    return apiResponse({ items: devices, page, pageSize, total });
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
