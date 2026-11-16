import { createSession, getSessionUser, phoneAppSignInRequired } from "@/lib/auth";
import { apiError, apiResponse, ApiError } from "@/lib/http";
import { SHARED_PHONE_ACTOR } from "@/lib/phone-access";

export const dynamic = "force-dynamic";

/**
 * Current user. Also re-issues the session cookie (sliding 30-day session).
 * Not signed in: while the phone app is open (the default) this answers with the shared identity
 * that phone-app actions are recorded under (`signedIn: false`); with PHONE_APP_REQUIRE_SIGN_IN
 * set it is 401 as before.
 */
export async function GET() {
  try {
    const signInRequired = phoneAppSignInRequired();
    const user = await getSessionUser();
    if (user) {
      await createSession(user);
      return apiResponse({ id: user.id, email: user.email, name: user.name, role: user.role, signedIn: true, signInRequired });
    }
    if (signInRequired) {
      throw new ApiError("Unauthenticated", 401);
    }
    return apiResponse({
      id: SHARED_PHONE_ACTOR.id,
      email: null,
      name: SHARED_PHONE_ACTOR.name,
      role: SHARED_PHONE_ACTOR.role,
      signedIn: false,
      signInRequired,
    });
  } catch (error) {
    return apiError(error);
  }
}
