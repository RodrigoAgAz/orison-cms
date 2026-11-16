import type { MetadataRoute } from "next";

// /robots.txt. This is an internal tool: nothing on it is for search engines, and the phone app
// (/m) and its API answer without signing in by default. Browsers ignore this file, so the phone
// app's manifest and icons (/m-app/...) still load and install normally.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
