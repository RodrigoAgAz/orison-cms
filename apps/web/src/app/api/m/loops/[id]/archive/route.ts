import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { actorMetadata, requirePhoneAppActor } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";
import { archiveMobileLoop } from "@/lib/mobile";

export const dynamic = "force-dynamic";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    const actor = await requirePhoneAppActor();
    const loop = await archiveMobileLoop(params.id);
    await logActivity("LOOP_ARCHIVED", `${actor.name} archived "${loop.name}"`, { loopId: loop.id, ...actorMetadata(actor) });
    revalidatePath("/loops");
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
