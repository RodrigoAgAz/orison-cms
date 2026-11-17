import { z } from "zod";

import { slotContentInputSchema } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { parseBody, toApiError } from "@/lib/loop-api";
import { saveSlots } from "@/lib/loops";
import { getLoopStates } from "@/lib/loop-queries";

type Props = { params: { id: string } };

const body = z.object({
  slots: z
    .array(
      z.object({
        position: z.number().int().min(0).max(9),
        contents: z.array(slotContentInputSchema),
        staticCreativeId: z.string().min(1).nullable().optional(),
        expectedUpdatedAt: z.string().datetime().nullable().optional(),
      }),
    )
    .min(1)
    .max(10),
});

/** Save the changed slots of a loop together; refused as a whole if any was changed by someone else. */
export async function PUT(request: Request, { params }: Props) {
  try {
    await requireApiUser();
    const parsed = await parseBody(request, body);
    const loop = await saveSlots(params.id, parsed.slots);
    const [state] = await getLoopStates([params.id]);
    return apiResponse({
      slots: loop?.slots.map((slot) => ({ position: slot.position, updatedAt: slot.updatedAt.toISOString() })) ?? [],
      state,
    });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
