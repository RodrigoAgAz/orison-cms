import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { archiveMobileLoop } from "@/lib/mobile";

export const dynamic = "force-dynamic";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireApiUser();
    const loop = await archiveMobileLoop(params.id);
    await logActivity("LOOP_ARCHIVED", `${user.name} archived "${loop.name}"`, { loopId: loop.id, userId: user.id });
    revalidatePath("/loops");
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
