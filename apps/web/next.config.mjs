/** @type {import('next').NextConfig} */
const nextConfig = {
  // Optional: isolate build output, e.g. NEXT_DIST_DIR=.next-dev to run a dev server next to a build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    typedRoutes: true,
    // src/instrumentation.ts: removes stale upload temp folders at server start.
    instrumentationHook: true,
  },
  // The phone app (/m) and its API can be used without signing in, so none of it may be indexed.
  // The middleware sets the same header on everything it handles; this also covers the raw upload
  // routes the middleware skips.
  async headers() {
    const noIndex = [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" }];
    return [
      { source: "/m", headers: noIndex },
      { source: "/m/:path*", headers: noIndex },
      { source: "/api/:path*", headers: noIndex },
    ];
  },
};

export default nextConfig;
