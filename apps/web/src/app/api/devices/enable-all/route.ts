import { revalidatePath } from "next/cache";

import { requireApiUser } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { setFleetControlState } from "@/lib/fleet-control";
import { apiError, apiResponse } from "@/lib/http";

export async function PUT() {
  try {
    await requireApiUser();
    await setFleetControlState({
      disabled: false,
      reason: null,
    });

    await logActivity("DEVICE_ENABLED", "All cabs resumed", {
      scope: "ALL_DEVICES",
    });

    revalidatePath("/");
    revalidatePath("/devices");

    return apiResponse({
      ok: true,
      disabled: false,
    });
  } catch (error) {
    return apiError(error);
  }
}
