import { revalidatePath } from "next/cache";

import { prisma } from "@orison/db";
import { deviceGroupInputSchema } from "@orison/shared";

import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

type Props = {
  params: {
    id: string;
  };
};

export async function PUT(request: Request, { params }: Props) {
  try {
    const body = await parseJsonBody(request, deviceGroupInputSchema);
    const group = await prisma.deviceGroup.update({
      where: { id: params.id },
      data: {
        name: body.name,
        description: body.description ?? null,
      },
    });

    await logActivity("DEVICE_GROUP_UPDATED", `Device group ${group.name} updated`, {
      groupId: group.id,
      name: group.name,
    });

    revalidatePath("/devices");
    revalidatePath("/loops");

    return apiResponse(group);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_: Request, { params }: Props) {
  try {
    const group = await prisma.deviceGroup.findUnique({
      where: { id: params.id },
      include: {
        _count: {
          select: {
            devices: true,
          },
        },
      },
    });

    if (!group) {
      throw new ApiError("Device group not found", 404);
    }

    if (group._count.devices > 0) {
      throw new ApiError("Remove devices from this group before deleting it", 409);
    }

    await prisma.loop.updateMany({
      where: { targetGroupId: group.id },
      data: { targetGroupId: null },
    });

    await prisma.deviceGroup.delete({
      where: { id: group.id },
    });

    await logActivity("DEVICE_GROUP_DELETED", `Device group ${group.name} deleted`, {
      groupId: group.id,
      name: group.name,
    });

    revalidatePath("/devices");
    revalidatePath("/loops");

    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
