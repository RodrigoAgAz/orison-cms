// Keeps the middleware's matcher deliberate (see the comment above `config` in src/middleware.ts):
// every API route and page runs the middleware, and no request body needs to be large, because
// Next buffers the whole body of any request that runs the middleware.

import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

import { PIECE_BYTES } from "../src/lib/chunked-upload";
import { config } from "../src/middleware";

const require = createRequire(import.meta.url);
// Next's own compiler for `config.matcher` (what the build and the dev server use).
const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
const { getMiddlewareRouteMatcher } = require("next/dist/shared/lib/router/utils/middleware-route-matcher.js");

const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers(config.matcher, {})) as (
  pathname: string,
  request: unknown,
  query: unknown,
) => boolean;
const runsMiddleware = (pathname: string) => matches(pathname, { headers: {}, cookies: {} }, {});

const appDir = path.join(__dirname, "..", "src", "app");

/** Every route handler under src/app/api, as a concrete path ([id] -> a sample id). */
function apiRoutes(dir = path.join(appDir, "api")): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...apiRoutes(full));
    else if (name === "route.ts") {
      const relative = path.relative(appDir, path.dirname(full)).split(path.sep);
      found.push(
        "/" +
          relative
            .map((segment) => (segment.startsWith("[...") ? "some/key.mp4" : segment.startsWith("[") ? "0123456789abcdef" : segment))
            .join("/"),
      );
    }
  }
  return found;
}

describe("middleware matcher", () => {
  it("runs for every API route, including every upload route", () => {
    const routes = apiRoutes();
    assert.ok(routes.length > 30, `found ${routes.length} API routes`);
    for (const route of [...routes, "/api/m/uploads/0123456789abcdef/pieces/0", "/api/uploads/0123456789abcdef/pieces/0"]) {
      assert.equal(runsMiddleware(route), true, `${route} must run the middleware`);
    }
  });

  it("runs for pages, including the phone app and its sign-in", () => {
    for (const page of ["/", "/loops", "/loops/abc", "/assets", "/devices", "/analytics", "/settings", "/login", "/m", "/m/upload", "/m/login", "/device-preview"]) {
      assert.equal(runsMiddleware(page), true, page);
    }
  });

  it("skips Next's own files and public files", () => {
    for (const file of ["/_next/static/chunks/main.js", "/m-app/icon-192.png", "/favicon.ico", "/manifest.webmanifest"]) {
      assert.equal(runsMiddleware(file), false, file);
    }
  });

  it("keeps every upload piece small enough to buffer", () => {
    // Raise this only together with the comment in src/middleware.ts.
    assert.ok(PIECE_BYTES <= 8 * 1024 * 1024, `PIECE_BYTES is ${PIECE_BYTES}`);
  });
});
