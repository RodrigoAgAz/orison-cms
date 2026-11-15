import { type NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const publicPrefixes = [
  "/login",
  "/device-preview",
  "/api/auth/login",
  "/api/devices/heartbeat",
  "/api/devices/manifest",
  "/api/devices/playback-log",
  "/api/storage",
];

const sessionCookieName = process.env.APP_SESSION_COOKIE ?? "orison_session";
const jwtSecret = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? "development-session-secret",
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

function continueWithPathname(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-orison-pathname", request.nextUrl.pathname);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  if (publicPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return continueWithPathname(request);
  }

  const authenticated = await hasValidSession(request);
  if (authenticated) {
    return continueWithPathname(request);
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Large raw-body upload routes are excluded: when middleware runs, Next 14 clones (buffers) the
// whole request body in memory before the handler starts, so a 500MB upload costs >500MB of RAM
// and the route cannot reject it early. Those routes authenticate the session themselves.
export const config = {
  matcher: [
    "/((?!api/m/upload|api/loops/direct-upload|.*\\..*).*)",
    "/api/((?!m/upload|loops/direct-upload).*)",
  ],
};
