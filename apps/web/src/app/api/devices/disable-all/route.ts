import { revalidatePath } from "next/cache";

import { z } from "zod";

import { requireApiUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { setFleetControlState } from "@/lib/fleet-control";
import { apiError, apiResponse, parseJsonBody } from "@/lib/http";

const disableAllSchema = z.object({
  reason: z.string().max(500).optional().nullable(),
});

export async function PUT(request: Request) {
  try {
    await requireApiUser();
    const body = await parseJsonBody(request, disableAllSchema);

    await setFleetControlState({
      disabled: true,
      reason: body.reason ?? null,
    });

    await logActivity("DEVICE_DISABLED", "All cabs paused", {
      scope: "ALL_DEVICES",
      reason: body.reason ?? null,
    });

    revalidatePath("/");
    revalidatePath("/devices");

    return apiResponse({
      ok: true,
      disabled: true,
      reason: body.reason ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}
