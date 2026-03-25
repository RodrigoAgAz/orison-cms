import { compare } from "bcryptjs";
import type { NextRequest } from "next/server";

import { prisma } from "@orison/db";

import { ApiError } from "./http";
import { env } from "./env";

function readBearerToken(request: NextRequest) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length);
}

export async function requireDevice(request: NextRequest, serialNumber: string) {
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

  if (!device) {
    throw new ApiError("Device not registered", 404);
  }

  if (device.apiTokenHash) {
    const valid = await compare(token, device.apiTokenHash);
    if (!valid) {
      throw new ApiError("Invalid device token", 401);
    }
    return device;
  }

  if (token !== env.deviceSharedToken) {
    throw new ApiError("Invalid device token", 401);
  }

  return device;
}

