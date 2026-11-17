import { z } from "zod";

import { prisma } from "@orison/db";

import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { changeLoopTarget, renameLoop } from "@/lib/loop-actions";
import { parseBody, toApiError } from "@/lib/loop-api";
import { deleteLoopAndObjects } from "@/lib/loop-publish";
import { getLoopStates } from "@/lib/loop-queries";

type Props = { params: { id: string } };

export async function GET(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    const loop = await prisma.loop.findUnique({
      where: { id: params.id },
      include: {
        slots: {
          orderBy: { position: "asc" },
          include: { contents: { orderBy: { orderInSlot: "asc" }, include: { asset: true } } },
        },
      },
    });
    if (!loop) {
      throw new ApiError("Loop not found", 404);
    }
    const [state] = await getLoopStates([loop.id]);
    return apiResponse({ ...loop, state });
  } catch (error) {
    return apiError(toApiError(error));
  }
}

// Only what the builder edits: the name, and the target of a loop that is not on air. Status
// changes have their own routes (publish, pause); moving a live loop is POST .../target.
const updateLoopBody = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    targetGroupId: z.string().min(1).nullable().optional(),
    expectedUpdatedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

export async function PUT(request: Request, { params }: Props) {
  try {
    const user = await requireApiUser();
    const body = await parseBody(request, updateLoopBody);
    if (body.targetGroupId !== undefined) {
      const result = await changeLoopTarget(params.id, body.targetGroupId, user, { expectedUpdatedAt: body.expectedUpdatedAt });
      if ("needsConfirmation" in result) {
        throw new ApiError("This loop is on air: changing where it plays needs confirmation (POST /api/loops/{id}/target).", 409, result);
      }
    }
    if (body.name !== undefined) {
      await renameLoop(params.id, body.name, body.targetGroupId !== undefined ? undefined : body.expectedUpdatedAt);
    }
    const loop = await prisma.loop.findUniqueOrThrow({ where: { id: params.id } });
    return apiResponse(loop);
  } catch (error) {
    return apiError(toApiError(error));
  }
}

export async function DELETE(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    const result = await deleteLoopAndObjects(params.id);
    return apiResponse({ ok: true, deletedObjects: result.deletedObjects.length });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
