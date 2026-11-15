import { createSession, requireApiUser } from "@/lib/auth";
import { apiError, apiResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Current user. Also re-issues the session cookie (sliding 30-day session). */
export async function GET() {
  try {
    const user = await requireApiUser();
    await createSession(user);
    return apiResponse({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch (error) {
    return apiError(error);
  }
}
