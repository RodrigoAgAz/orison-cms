/** @type {import('next').NextConfig} */
const nextConfig = {
  // Optional: isolate build output, e.g. NEXT_DIST_DIR=.next-dev to run a dev server next to a build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    typedRoutes: true,
    // src/instrumentation.ts: removes stale upload temp folders at server start.
    instrumentationHook: true,
  },
};

export default nextConfig;
