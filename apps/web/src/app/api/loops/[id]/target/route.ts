import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { changeLoopTarget, effectLines } from "@/lib/loop-actions";
import { parseBody, toApiError } from "@/lib/loop-api";

type Props = { params: { id: string } };

/**
 * Change where a loop plays (null = all cabs). For a live loop the first call only answers what
 * would change on which cabs, with a token; calling again with that token applies and logs it.
 */
export async function POST(request: Request, { params }: Props) {
  try {
    const user = await requireApiUser();
    const body = await parseBody(
      request,
      z.object({
        targetGroupId: z.string().min(1).nullable(),
        token: z.string().nullable().optional(),
        expectedUpdatedAt: z.string().datetime().nullable().optional(),
      }),
    );
    const result = await changeLoopTarget(params.id, body.targetGroupId, user, { token: body.token, expectedUpdatedAt: body.expectedUpdatedAt });
    return apiResponse({ ...result, lines: result.effect ? effectLines(result.effect) : [] });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
