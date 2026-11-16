// Who may use the phone app (/m) and its API without signing in. Pure and edge-safe: imported by
// the middleware as well as by route handlers, and unit tested (test/phone-access.test.ts).
//
// By the owner's decision the phone app is open: anyone with the address can see the cabs and
// change what plays, with no sign-in. Setting PHONE_APP_REQUIRE_SIGN_IN=true restores sign-in for
// the phone app exactly as before, with no code change. Team management, password changes, the
// desktop site and every desktop-only API route always require sign-in.

/** Environment variable that turns sign-in back on for the phone app. */
export const PHONE_APP_REQUIRE_SIGN_IN_ENV = "PHONE_APP_REQUIRE_SIGN_IN";

/** True when the phone app requires sign-in. Default (unset/empty/anything else): open access. */
export function phoneAppRequiresSignIn(value: string | undefined | null): boolean {
  return ["true", "1", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/**
 * The shared identity that phone-app actions taken without signing in are recorded under. It is
 * not a database row: `id` contains a colon, which no generated user id (cuid) does, so it never
 * matches a real user, and nothing looks it up. The role is EDITOR, so every admin check refuses it.
 */
export const SHARED_PHONE_ACTOR = {
  id: "anonymous:phone-app",
  name: "Phone app (not signed in)",
  role: "EDITOR" as const,
};

export function isSharedPhoneActorId(id: string | null | undefined) {
  return id === SHARED_PHONE_ACTOR.id;
}

/** Pages of the phone app (`/m`, `/m/...`). */
export function isPhoneAppPage(pathname: string) {
  return pathname === "/m" || pathname.startsWith("/m/");
}

const pauseRoute = /^\/api\/devices\/[^/]+\/(disable|enable)\/?$/;

/**
 * API routes the phone app uses, which open access lets through without a session. Everything
 * else under /api keeps requiring sign-in (team management, password, desktop-only routes).
 * The routes still decide who the caller is themselves (signed-in user or the shared identity).
 */
export function isPhoneAppApiRoute(method: string, pathname: string) {
  const verb = method.toUpperCase();
  if (pathname.startsWith("/api/m/")) {
    return true;
  }
  if (pathname === "/api/auth/me") {
    return verb === "GET" || verb === "HEAD";
  }
  // Pause / resume one cab. The phone uses POST; the desktop site's PUT stays signed-in only.
  if (pauseRoute.test(pathname)) {
    return verb === "POST";
  }
  return false;
}

/**
 * Client address for the activity log, from the proxy headers. `ip` is the first X-Forwarded-For
 * entry (what the client claims; spoofable), `forwardedFor` the whole chain as received, so the
 * address added by our own proxy is kept too.
 */
export function requestAddress(headers: { get(name: string): string | null }) {
  const forwardedFor = headers.get("x-forwarded-for")?.trim() || null;
  const first = forwardedFor?.split(",")[0]?.trim() || null;
  const realIp = headers.get("x-real-ip")?.trim() || null;
  return {
    ip: (first ?? realIp ?? "unknown").slice(0, 100),
    forwardedFor: forwardedFor ? forwardedFor.slice(0, 300) : null,
  };
}

/**
 * Rolling-window counter: at most `limit` events in any `windowMs`. Used to cap uploads made
 * without signing in (across all such callers). `check` peeks, `take` records an event.
 */
export function createRollingLimit({ limit, windowMs }: { limit: number; windowMs: number }) {
  let events: number[] = [];
  const prune = (now: number) => {
    events = events.filter((at) => at > now - windowMs);
  };
  const status = (now: number) => {
    prune(now);
    const allowed = events.length < limit;
    // When full, the next slot frees up when the oldest event leaves the window.
    const retryAfterMs = allowed ? 0 : Math.max(0, events[0] + windowMs - now);
    return { allowed, used: events.length, limit, retryAfterMs };
  };
  return {
    check(now = Date.now()) {
      return status(now);
    },
    take(now = Date.now()) {
      const result = status(now);
      if (result.allowed) {
        events.push(now);
        return { ...result, used: result.used + 1 };
      }
      return result;
    },
  };
}

/** Default ceiling on uploads made without signing in, per rolling hour, across all such callers. */
export const DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR = 20;

export function anonymousUploadLimitFrom(value: string | undefined | null) {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR;
}

export function uploadLimitMessage(limit: number, retryAfterMs: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return (
    `The phone app has had ${limit} video uploads in the last hour without anyone signed in, which is the most it accepts. ` +
    `Try again in ${minutes === 1 ? "1 minute" : `${minutes} minutes`}, or sign in under Account to upload now.`
  );
}
