import { type NextRequest } from "next/server";

import { prisma } from "@orison/db";
import { heartbeatSchema } from "@orison/shared";

import { apiError, apiResponse, parseJsonBody } from "@/lib/http";
import { authenticateDeviceRequest } from "@/lib/device-auth";
import { enforceDeviceRateLimit } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
  try {
    const body = await parseJsonBody(request, heartbeatSchema);
    enforceDeviceRateLimit(request, "device-heartbeat", body.serialNumber, {
      limit: 120,
      windowMs: 5 * 60 * 1000,
    });
    await authenticateDeviceRequest(request, body.serialNumber, {
      allowUnregisteredSharedToken: true,
    });

    const device = await prisma.device.upsert({
      where: { serialNumber: body.serialNumber },
      update: {
        ipAddress: body.ipAddress,
        firmwareVersion: body.firmwareVersion,
        storageFreeMb: body.storageFreeMb,
        currentLoopId: body.currentLoopId,
        lastHeartbeatAt: new Date(),
      },
      create: {
        serialNumber: body.serialNumber,
        ipAddress: body.ipAddress,
        firmwareVersion: body.firmwareVersion,
        storageFreeMb: body.storageFreeMb,
        currentLoopId: body.currentLoopId,
        lastHeartbeatAt: new Date(),
      },
    });

    await prisma.deviceHeartbeat.create({
      data: {
        deviceId: device.id,
        ipAddress: body.ipAddress,
        firmwareVersion: body.firmwareVersion,
        storageFreeMb: body.storageFreeMb,
        currentLoopId: body.currentLoopId,
        cpuTemp: body.cpuTemp,
        uptimeSeconds: body.uptimeSeconds,
        memoryUsedPercent: body.memoryUsedPercent,
        playerStatus: body.playerStatus,
        networkType: body.networkType,
        signalStrength: body.signalStrength,
      },
    });

    return apiResponse({ ok: true, deviceId: device.id });
  } catch (error) {
    return apiError(error);
  }
}
