import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { toApiError } from "@/lib/loop-api";
import { startLoopPublish } from "@/lib/loop-publish";
import { getLoopStates } from "@/lib/loop-queries";

type Props = { params: { id: string } };

/**
 * Start publishing. Returns at once (202) with the loop's state; the compile runs in the
 * background and the builder polls GET (below) for progress and the outcome.
 */
export async function POST(_: Request, { params }: Props) {
  try {
    const user = await requireApiUser();
    const result = await startLoopPublish(params.id, user);
    const [state] = await getLoopStates([params.id]);
    return apiResponse({ ok: true, ...result, state }, { status: result.kind === "on-air" ? 200 : 202 });
  } catch (error) {
    return apiError(toApiError(error));
  }
}

export async function GET(_: Request, { params }: Props) {
  try {
    await requireApiUser();
    const [state] = await getLoopStates([params.id]);
    if (!state) throw new ApiError("Loop not found", 404);
    return apiResponse({ state });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
