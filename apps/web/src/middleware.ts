import { type NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

import { isPhoneAppApiRoute, isPhoneAppPage, phoneAppRequiresSignIn, PHONE_APP_REQUIRE_SIGN_IN_ENV } from "./lib/phone-access";

const publicPrefixes = [
  "/login",
  "/m/login",
  "/device-preview",
  "/api/auth/login",
  "/api/devices/heartbeat",
  "/api/devices/manifest",
  "/api/devices/playback-log",
  "/api/storage",
];

const sessionCookieName = process.env.APP_SESSION_COOKIE ?? "orison_session";
// Same secret as lib/env.ts (SESSION_SECRET; NEXTAUTH_SECRET is the old name, still accepted).
const jwtSecret = new TextEncoder().encode(
  process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET || "development-session-secret",
);

async function hasValidSession(request: NextRequest) {
  const token = request.cookies.get(sessionCookieName)?.value;
  if (!token) {
    return false;
  }

  try {
    await jwtVerify(token, jwtSecret);
    return true;
  } catch {
    return false;
  }
}

// Nothing on this site is meant for search engines (see also src/app/robots.ts). The phone app and
// its API can be opened without signing in, so every response that passes through here says so.
const robotsHeader = "noindex, nofollow, noarchive, nosnippet";

function noIndex<T extends NextResponse>(response: T) {
  response.headers.set("X-Robots-Tag", robotsHeader);
  return response;
}

function continueWithPathname(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-orison-pathname", request.nextUrl.pathname);

  return noIndex(
    NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    }),
  );
}

// Phones get the mobile app (/m) at the site root; tablets and desktops keep the desktop app.
const phoneUserAgent = /iPhone|iPod|Android.+Mobile|Windows Phone|Mobile.+Firefox/i;
// Set by the "Use the desktop site" link in the mobile app (/?view=desktop).
const viewCookieName = "orison_view";

const isMobilePath = isPhoneAppPage;

function mobileEntryRedirect(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;
  if (pathname !== "/") {
    return null;
  }
  const view = searchParams.get("view");
  if (view === "desktop" || view === "mobile") {
    const url = request.nextUrl.clone();
    url.searchParams.delete("view");
    if (view === "mobile") {
      url.pathname = "/m";
    }
    const response = NextResponse.redirect(url);
    if (view === "desktop") {
      response.cookies.set(viewCookieName, "desktop", { path: "/", maxAge: 60 * 60 * 24 * 30, sameSite: "lax" });
    } else {
      response.cookies.delete(viewCookieName);
    }
    return response;
  }
  if (request.cookies.get(viewCookieName)?.value === "desktop") {
    return null;
  }
  if (!phoneUserAgent.test(request.headers.get("user-agent") ?? "")) {
    return null;
  }
  const url = request.nextUrl.clone();
  url.pathname = "/m";
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  const entryRedirect = mobileEntryRedirect(request);
  if (entryRedirect) {
    return noIndex(entryRedirect);
  }

  if (publicPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return continueWithPathname(request);
  }

  const authenticated = await hasValidSession(request);
  if (authenticated) {
    return continueWithPathname(request);
  }

  // Open phone app (the default; PHONE_APP_REQUIRE_SIGN_IN=true turns it off at runtime): its pages
  // and the API routes it uses need no session. The routes themselves record the caller as the
  // shared "not signed in" identity and still refuse anything that needs a real user.
  if (!phoneAppRequiresSignIn(process.env[PHONE_APP_REQUIRE_SIGN_IN_ENV])) {
    if (isMobilePath(pathname) || isPhoneAppApiRoute(request.method, pathname)) {
      return continueWithPathname(request);
    }
  }

  if (pathname.startsWith("/api/")) {
    return noIndex(NextResponse.json({ error: "Unauthenticated" }, { status: 401 }));
  }

  const url = request.nextUrl.clone();
  if (isMobilePath(pathname)) {
    // Mobile app: sign in on the phone-sized page and come back to the same screen afterwards.
    const next = `${pathname}${request.nextUrl.search}`;
    url.pathname = "/m/login";
    url.search = "";
    url.searchParams.set("next", next);
    return noIndex(NextResponse.redirect(url));
  }
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return noIndex(NextResponse.redirect(url));
}

// Large raw-body upload routes are excluded: when middleware runs, Next 14 clones (buffers) the
// whole request body in memory before the handler starts, so a 500MB upload costs >500MB of RAM
// and the route cannot reject it early. Those routes authenticate the session themselves.
export const config = {
  matcher: [
    "/((?!api/m/upload|api/loops/direct-upload|api/assets/upload|.*\\..*).*)",
    "/api/((?!m/upload|loops/direct-upload|assets/upload).*)",
  ],
};
