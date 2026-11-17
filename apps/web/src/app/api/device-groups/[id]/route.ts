import { revalidatePath } from "next/cache";

import { prisma } from "@orison/db";
import { deviceGroupInputSchema } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { parseBody, toApiError } from "@/lib/loop-api";

type Props = {
  params: {
    id: string;
  };
};

export async function PUT(request: Request, { params }: Props) {
  try {
    await requireApiUser();
    const body = await parseBody(request, deviceGroupInputSchema);
    const group = await prisma.deviceGroup.update({
      where: { id: params.id },
      data: {
        name: body.name,
        description: body.description ?? null,
      },
    });

    await logActivity("DEVICE_GROUP_UPDATED", `Group ${group.name} updated`, {
      groupId: group.id,
      name: group.name,
    });

    revalidatePath("/devices");
    revalidatePath("/loops");

    return apiResponse(group);
  } catch (error) {
    return apiError(toApiError(error));
  }
}

export async function DELETE(_: Request, { params }: Props) {
  try {
    await requireApiUser();
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
      throw new ApiError("Group not found", 404);
    }

    if (group._count.devices > 0) {
      throw new ApiError("Move the cabs out of this group before deleting it.", 409);
    }

    // Deleting a group must never put its loops on every cab (a null target means all cabs).
    const live = await prisma.loop.findMany({
      where: { targetGroupId: group.id, status: { in: ["PUBLISHED", "PUBLISHING"] } },
      select: { name: true },
    });
    if (live.length > 0) {
      throw new ApiError(
        `${live.map((loop) => `"${loop.name}"`).join(", ")} ${live.length === 1 ? "is" : "are"} on air for this group. Pause ${
          live.length === 1 ? "it" : "them"
        } or move ${live.length === 1 ? "it" : "them"} to another group first.`,
        409,
      );
    }

    // Loops that are not on air keep nothing pointing at the deleted group; their target becomes
    // "All cabs", which their next publish states and asks to confirm.
    const retargeted = await prisma.loop.findMany({ where: { targetGroupId: group.id }, select: { id: true, name: true } });
    await prisma.loop.updateMany({
      where: { targetGroupId: group.id },
      data: { targetGroupId: null },
    });

    await prisma.deviceGroup.delete({
      where: { id: group.id },
    });

    await logActivity("DEVICE_GROUP_DELETED", `Group ${group.name} deleted`, {
      groupId: group.id,
      name: group.name,
      retargetedLoops: retargeted.map((loop) => loop.id),
    });

    revalidatePath("/devices");
    revalidatePath("/loops");

    return apiResponse({ ok: true, retargetedLoops: retargeted });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
