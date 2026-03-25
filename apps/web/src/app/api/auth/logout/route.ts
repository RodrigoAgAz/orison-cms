import { clearSession } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";

export async function POST() {
  try {
    await clearSession();
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}

