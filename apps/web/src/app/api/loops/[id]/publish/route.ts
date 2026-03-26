import { revalidatePath } from "next/cache";
import { prisma } from "@orison/db";

import { getSessionUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { startLoopPublishProcess } from "@/lib/publish-loop-process";

type Props = {
  params: {
    id: string;
  };
};

export async function POST(_: Request, { params }: Props) {
  try {
    const user = await getSessionUser();
    if (!user) {
      throw new ApiError("Unauthenticated", 401);
    }

    const loop = await prisma.loop.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        status: true,
      },
    });

    if (!loop) {
      throw new ApiError("Loop not found", 404);
    }

    if (loop.status === "PUBLISHING") {
      return apiResponse({
        ok: true,
        status: "PUBLISHING",
        loopId: loop.id,
      });
    }

    await prisma.loop.update({
      where: { id: loop.id },
      data: {
        status: "PUBLISHING",
        publishError: null,
      },
    });

    try {
      startLoopPublishProcess(loop.id, user.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start publish process";
      await prisma.loop.update({
        where: { id: loop.id },
        data: {
          status: "DRAFT",
          publishError: message,
        },
      });
      throw new ApiError(message, 500);
    }

    revalidatePath("/");
    revalidatePath("/loops");
    revalidatePath(`/loops/${params.id}`);
    revalidatePath("/devices");

    return apiResponse({
      ok: true,
      status: "PUBLISHING",
      loopId: loop.id,
    });
  } catch (error) {
    return apiError(error);
  }
}
