import { prisma } from "@orison/db";
import { deviceUpdateSchema } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { publicDevice } from "@/lib/device-public";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

// GET is not used by any screen; kept because apps/web/e2e/mobile.e2e.mjs checks that a removed
// user's session is refused here. It returns the Device row only (no heartbeats or playback rows).
export async function GET(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    const device = await prisma.device.findUnique({
      where: { id: params.id },
    });

    if (!device) {
      throw new ApiError("Device not found", 404);
    }

    return apiResponse(publicDevice(device));
  } catch (error) {
    return apiError(error);
  }
}

export async function PUT(request: Request, { params }: Props) {
  try {
    await requireApiUser();
    const body = await parseJsonBody(request, deviceUpdateSchema);
    const device = await prisma.device.update({
      where: { id: params.id },
      data: body,
    });
    return apiResponse(publicDevice(device));
  } catch (error) {
    return apiError(error);
  }
}
