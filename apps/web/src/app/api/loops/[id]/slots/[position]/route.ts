import { z } from "zod";

import { slotContentInputSchema } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { parseBody, toApiError } from "@/lib/loop-api";
import { updateSlotContents } from "@/lib/loops";

type Props = {
  params: {
    id: string;
    position: string;
  };
};

const body = z.object({
  contents: z.array(slotContentInputSchema),
  staticCreativeId: z.string().min(1).nullable().optional(),
  expectedUpdatedAt: z.string().datetime().nullable().optional(),
});

export async function PUT(request: Request, { params }: Props) {
  try {
    await requireApiUser();
    const parsed = await parseBody(request, body);
    const loop = await updateSlotContents(
      params.id,
      Number.parseInt(params.position, 10),
      parsed.contents,
      parsed.staticCreativeId,
      parsed.expectedUpdatedAt,
    );
    return apiResponse({ loop });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
