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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  if (publicPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const authenticated = await hasValidSession(request);
  if (authenticated) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!.*\\..*).*)", "/api/:path*"],
};
