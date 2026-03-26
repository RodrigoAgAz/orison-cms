import { revalidatePath } from "next/cache";
import { prisma } from "@orison/db";

import { getSessionUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { publishLoop } from "@/lib/loops";

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

    const transition = await prisma.loop.updateMany({
      where: {
        id: loop.id,
        status: loop.status,
      },
      data: {
        status: "PUBLISHING",
        publishError: null,
      },
    });

    if (transition.count === 0) {
      const current = await prisma.loop.findUnique({
        where: { id: loop.id },
        select: {
          id: true,
          status: true,
          publishError: true,
        },
      });

      if (!current) {
        throw new ApiError("Loop not found", 404);
      }

      return apiResponse({
        ok: true,
        status: current.status,
        loopId: current.id,
        publishError: current.publishError,
      });
    }

    try {
      await publishLoop(loop.id, user.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Loop publish failed unexpectedly";
      await prisma.loop.update({
        where: { id: loop.id },
        data: {
          status: loop.status,
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
      status: "PUBLISHED",
      loopId: loop.id,
    });
  } catch (error) {
    return apiError(error);
  }
}
