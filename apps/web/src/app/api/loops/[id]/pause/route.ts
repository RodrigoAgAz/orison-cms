import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { effectLines, pauseLoop } from "@/lib/loop-actions";
import { parseBody, toApiError } from "@/lib/loop-api";

type Props = { params: { id: string } };

/**
 * Take a loop off air. Without a token (or with a stale one) a live loop is not changed: the
 * answer says what each affected cab would play instead and carries the token to confirm with.
 */
export async function POST(request: Request, { params }: Props) {
  try {
    const user = await requireApiUser();
    const body = await parseBody(request, z.object({ token: z.string().nullable().optional() }));
    const result = await pauseLoop(params.id, user, body.token);
    return apiResponse({ ...result, lines: effectLines(result.effect) });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
