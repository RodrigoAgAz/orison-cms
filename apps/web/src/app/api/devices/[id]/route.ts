import { prisma } from "@orison/db";
import { deviceUpdateSchema } from "@orison/shared";

import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

export async function GET(_: Request, { params }: Props) {
  try {
    const device = await prisma.device.findUnique({
      where: { id: params.id },
      include: {
        heartbeats: {
          orderBy: { receivedAt: "desc" },
          take: 50,
        },
        playbackLogs: {
          orderBy: { playedAt: "desc" },
          take: 100,
        },
      },
    });

    if (!device) {
      throw new ApiError("Device not found", 404);
    }

    return apiResponse(device);
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request, { params }: Props) {
  try {
    const body = await parseJsonBody(request, deviceUpdateSchema);
    const device = await prisma.device.update({
      where: { id: params.id },
      data: body,
    });
    return apiResponse(device);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_: Request, { params }: Props) {
  try {
    await prisma.device.update({
      where: { id: params.id },
      data: { isActive: false },
    });
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

