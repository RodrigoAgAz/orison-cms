import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { toApiError } from "@/lib/loop-api";
import { getLoopStates } from "@/lib/loop-queries";

// Reads the session cookie: never pre-rendered at build time.
export const dynamic = "force-dynamic";

/** GET /api/loops/state?ids=a,b: live state of several loops (the loops list polls this). */
export async function GET(request: Request) {
  try {
    await requireApiUser();
    const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 100);
    return apiResponse({ items: ids.length ? await getLoopStates(ids) : [] });
  } catch (error) {
    return apiError(toApiError(error));
  }
}
