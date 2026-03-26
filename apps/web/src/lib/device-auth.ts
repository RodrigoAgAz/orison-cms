import { compare } from "bcryptjs";
import type { NextRequest } from "next/server";

import { prisma, type Device } from "@orison/db";

import { ApiError } from "./http";
import { env } from "./env";

export function readBearerToken(request: NextRequest) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length);
}

export function getRequestIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "unknown";
}

export async function authenticateDeviceRequest(
  request: NextRequest,
  serialNumber: string,
  options?: {
    allowUnregisteredSharedToken?: boolean;
  },
) {
  const token =
    readBearerToken(request) ??
    request.headers.get("x-device-token") ??
    request.nextUrl.searchParams.get("token");

  if (!token) {
    throw new ApiError("Missing device token", 401);
  }

  const device = await prisma.device.findUnique({
    where: { serialNumber },
  });

  if (device?.apiTokenHash) {
    const valid = await compare(token, device.apiTokenHash);
    if (!valid) {
      throw new ApiError("Invalid device token", 401);
    }
    return device;
  }

  if (token !== env.deviceSharedToken) {
    throw new ApiError("Invalid device token", 401);
  }

  if (!device && !options?.allowUnregisteredSharedToken) {
    throw new ApiError("Device not registered", 404);
  }

  return device;
}

export async function requireDevice(request: NextRequest, serialNumber: string): Promise<Device> {
  const device = await authenticateDeviceRequest(request, serialNumber);
  if (!device) {
    throw new ApiError("Device not registered", 404);
  }

  return device;
}
