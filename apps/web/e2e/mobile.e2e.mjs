// End-to-end test of the phone app (/m) against a running dev server, in iPhone emulation.
//
//   node apps/web/e2e/mobile.e2e.mjs
//
// Env: BASE_URL (default http://localhost:3000), SHOTS_DIR (screenshots; default apps/web/e2e/shots),
//      E2E_EMAIL / E2E_PASSWORD (default: the seeded admin). Needs the demo fleet (npm run demo:seed),
//      ffmpeg on PATH and Playwright with Chromium. The run reseeds the demo data at the start and
//      restores it at the end. External hosts (map tiles, fonts) are blocked on purpose: the app
//      must work without them.
//
// "End to end" here means: after each content change made through the UI, a real device request
// (GET /api/devices/manifest as the cab) must return the new video.
//
// Access modes (lib/phone-access.ts). By default the phone app is open: no sign-in, actions are
// recorded as the shared identity "Phone app (not signed in)". The server at BASE_URL is tested in
// whichever mode it runs in. In open mode the run also starts two extra dev servers from this
// checkout (ports E2E_EXTRA_PORT and +1, default 3101/3102, each with its own build folder, removed
// afterwards; apps/web/tsconfig.json and next-env.d.ts are restored if `next dev` touches them):
//   - open, with PHONE_APP_ANON_UPLOADS_PER_HOUR=3, to trigger the anonymous upload ceiling without
//     using up the main server's allowance;
//   - PHONE_APP_REQUIRE_SIGN_IN=true, where the old sign-in flow must work exactly as before.
// E2E_SPAWN=0 skips those two (and says so).
//
// Each run uploads 3 videos without signing in on the main server (the ceiling there is 20 per
// rolling hour by default), so up to about six runs an hour fit.

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const run = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const webDir = path.join(repoRoot, "apps/web");
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOTS_DIR ?? path.join(here, "shots");
const EMAIL = process.env.E2E_EMAIL ?? "admin@orisonscreens.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "ChangeMe123!";
const DEVICE_TOKEN = process.env.DEVICE_SHARED_TOKEN ?? "local-device-token";
const RUN_ID = Date.now().toString(36);
const RUN_STARTED = new Date();
const SPAWN = process.env.E2E_SPAWN !== "0";
const EXTRA_PORT = Number(process.env.E2E_EXTRA_PORT ?? 3101);
const SHARED_NAME = "Phone app (not signed in)";
const SHARED_ID = "anonymous:phone-app";

mkdirSync(SHOTS, { recursive: true });
const workDir = mkdtempSync(path.join(os.tmpdir(), "orison-e2e-"));

// ------------------------------------------------------------------------------------------ utils

let step = 0;
const results = [];
async function check(name, fn) {
  const started = Date.now();
  process.stdout.write(`- ${name} ... `);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log("FAILED");
    console.log(String(error?.stack ?? error).split("\n").slice(0, 8).join("\n"));
    throw error;
  }
}

function skip(name, reason) {
  results.push({ name, ok: true, skipped: true });
  console.log(`- ${name} ... SKIPPED (${reason})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function shot(page, name, options = {}) {
  step += 1;
  const file = path.join(SHOTS, `${String(step).padStart(2, "0")}-${name}.png`);
  await page.waitForTimeout(options.settle ?? 350);
  if (options.fullPage) {
    // Pin the fixed bars to the end of the page so a full-length capture reads like a scroll.
    const style = await page.addStyleTag({
      content: ".m-tabbar,.m-pill{position:absolute!important}.m-stickyactions,.m-topbar{position:static!important}",
    });
    await page.screenshot({ path: file, fullPage: true });
    await style.evaluate((node) => node.remove());
  } else {
    await page.screenshot({ path: file });
  }
  return file;
}

async function npm(script, extra = []) {
  const env = { ...process.env };
  await run("npm", ["run", script, "--silent", "--", ...extra], { cwd: repoRoot, env, timeout: 300_000 }).catch((error) => {
    throw new Error(`npm run ${script} failed: ${error.stderr || error.message}`);
  });
}

async function loadEnvFile() {
  try {
    process.loadEnvFile(path.join(repoRoot, ".env"));
  } catch {
    // optional
  }
}

/** What the cab would be served right now: a real device manifest request. */
async function manifestFor(serial, base = BASE) {
  const response = await fetch(`${base}/api/devices/manifest`, {
    headers: { "X-Device-Serial": serial, Authorization: `Bearer ${DEVICE_TOKEN}` },
  });
  const body = await response.json();
  assert(response.ok, `manifest for ${serial}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function apiJson(page, url, init) {
  const target = url.startsWith("http") ? url : `${BASE}${url}`;
  const response = init ? await page.request.fetch(target, init) : await page.request.get(target);
  return { status: response.status(), body: await response.json().catch(() => null), headers: response.headers() };
}

/** A request with no cookies at all: what a stranger on the internet gets. */
async function anon(url, init = {}, base = BASE) {
  const response = await fetch(`${base}${url}`, {
    redirect: "manual",
    ...init,
    headers: { Accept: "application/json", ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

/** Signed-in admin requests from Node (for setup that only the desktop site can do). */
async function adminSession(base = BASE) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert(login.ok, `admin login ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  return (url, init = {}) => anon(url, { ...init, headers: { cookie, ...(init.headers ?? {}) } }, base);
}

function tab(page, name) {
  return page.locator(".m-tabbar").getByRole("link", { name, exact: true });
}

async function goto(page, url, base = BASE) {
  await page.goto(`${base}${url}`, { waitUntil: "domcontentloaded" });
}

async function makeVideo(file, seconds = 3, size = "1280x720") {
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mov", file,
  ]);
  return file;
}

async function newPhoneContext(browser, device = devices["iPhone 14"], extra = {}, base = BASE) {
  const context = await browser.newContext({ ...device, deviceScaleFactor: 2, locale: "en-GB", timezoneId: "Europe/London", ...extra });
  // Block every external host (map tiles, web fonts): the app must still work.
  await context.route((url) => url.hostname !== new URL(base).hostname, (route) => route.abort());
  return context;
}

async function login(page, { expectNext } = {}) {
  await page.locator('[data-testid="login-submit"]:not([disabled])').waitFor();
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('[data-testid="login-submit"]');
  if (expectNext) await page.waitForURL(`**${expectNext}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
}

async function serverMode(base) {
  const me = await anon("/api/auth/me", {}, base);
  if (me.status === 401) return "sign-in-required";
  assert(me.status === 200, `GET /api/auth/me ${me.status}`);
  return me.body.signInRequired ? "sign-in-required" : "open";
}

let prismaClient = null;
function db() {
  if (!prismaClient) {
    const { PrismaClient } = require("@prisma/client");
    prismaClient = new PrismaClient();
  }
  return prismaClient;
}

/** Activity events of this run (since it started), newest first. */
async function activitySince(types) {
  return db().activityEvent.findMany({
    where: { createdAt: { gte: RUN_STARTED }, ...(types ? { type: { in: types } } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Start an extra `next dev` from this checkout on `port` with `env`, run `fn(base)`, stop it.
 * Uses its own build folder (removed afterwards) and restores the files `next dev` may rewrite.
 */
async function withExtraServer(port, env, fn) {
  const distDir = `.next-e2e-${port}`;
  const touched = ["tsconfig.json", "next-env.d.ts"].map((name) => path.join(webDir, name));
  const before = touched.map((file) => (existsSync(file) ? readFileSync(file, "utf8") : null));
  const logFile = path.join(workDir, `server-${port}.log`);
  const child = spawn(process.execPath, [path.join(repoRoot, "node_modules/next/dist/bin/next"), "dev", "-p", String(port)], {
    cwd: webDir,
    env: { ...process.env, ...env, NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", openSync(logFile, "a"), openSync(logFile, "a")],
    detached: true,
  });
  const base = `http://localhost:${port}`;
  try {
    const deadline = Date.now() + 180_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/robots.txt`);
        if (response.ok) break;
      } catch {
        // not up yet
      }
      if (child.exitCode !== null) throw new Error(`server on ${port} exited; see ${logFile}`);
      if (Date.now() > deadline) throw new Error(`server on ${port} did not start; see ${logFile}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return await fn(base);
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // gone
        }
        resolve();
      }, 10_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    rmSync(path.join(webDir, distDir), { recursive: true, force: true });
    touched.forEach((file, index) => {
      if (before[index] !== null && readFileSync(file, "utf8") !== before[index]) writeFileSync(file, before[index]);
    });
  }
}

// ------------------------------------------------------------------------------------------ test

const created = { loops: new Set(), users: new Set() };

async function main() {
  await loadEnvFile();
  console.log(`Orison mobile e2e against ${BASE}; screenshots in ${SHOTS}`);
  await check("reset demo data and bring live cabs online", async () => {
    await npm("demo:seed");
    await npm("demo:heartbeat");
  });

  const mode = await serverMode(BASE);
  console.log(`  server at ${BASE} runs with the phone app ${mode === "open" ? "OPEN (no sign-in)" : "requiring sign-in"}`);

  const browser = await chromium.launch();
  try {
    if (mode === "open") {
      await openSuite(browser);
      if (SPAWN) {
        await withExtraServer(EXTRA_PORT, { PHONE_APP_ANON_UPLOADS_PER_HOUR: "3", PHONE_APP_REQUIRE_SIGN_IN: "false" }, (base) =>
          uploadCeilingSuite(browser, base),
        );
        await withExtraServer(EXTRA_PORT + 1, { PHONE_APP_REQUIRE_SIGN_IN: "true" }, (base) => signInRequiredSuite(browser, base));
      } else {
        skip("anonymous upload ceiling (extra server)", "E2E_SPAWN=0");
        skip("PHONE_APP_REQUIRE_SIGN_IN=true restores sign-in (extra server)", "E2E_SPAWN=0");
      }
    } else {
      await signInRequiredSuite(browser, BASE);
      skip("open phone app (no sign-in)", "the server at BASE_URL requires sign-in; run it without PHONE_APP_REQUIRE_SIGN_IN");
    }
    await check("icon contact sheet (every generated icon at its real sizes)", () => iconContactSheet(browser));
  } finally {
    await browser.close().catch(() => undefined);
    await cleanup();
  }
}

// ============================================================================ open (default) mode

async function openSuite(browser) {
  const context = await newPhoneContext(browser);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => console.log(`  [pageerror] ${error.message}`));

  // ---------------------------------------------------------------- straight in
  await check("no sign-in: /m opens straight onto the cabs, windmill in the header", async () => {
    await goto(page, "/m");
    await page.getByTestId("cab-list").waitFor();
    assert(new URL(page.url()).pathname === "/m", `stayed on /m (${page.url()})`);
    assert((await page.locator('input[type="password"]').count()) === 0, "no password field anywhere");
    const mark = page.locator(".m-home-brand img.m-brandmark");
    await mark.waitFor();
    const natural = await mark.evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight, src: img.getAttribute("src"), shown: img.getBoundingClientRect().height }));
    assert(natural.src === "/m-app/windmill-gold.png" && natural.h >= 3 * natural.shown, `windmill sharp on retina: ${JSON.stringify(natural)}`);
    await page.getByTestId("install-hint").waitFor();
    await shot(page, "home");
    await goto(page, "/m/videos");
    await page.getByTestId("video-list").waitFor();
    assert(!page.url().includes("/m/login"), "deep link opens without sign-in");
  });

  await check("a phone at the site root goes straight to the app; the desktop site still needs sign-in", async () => {
    const phone = await newPhoneContext(browser);
    const phonePage = await phone.newPage();
    await phonePage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await phonePage.waitForURL(/\/m$/);
    await phonePage.getByTestId("cab-list").waitFor();
    await phonePage.goto(`${BASE}/?view=desktop`, { waitUntil: "domcontentloaded" });
    await phonePage.waitForURL(/\/login\?next=%2F$/);
    assert(!phonePage.url().includes("/m/"), "explicit desktop link works on a phone");
    await phone.close();
  });

  await check("who am I without signing in: the shared identity, no email, no activity feed", async () => {
    const me = await anon("/api/auth/me");
    assert(me.status === 200, `me ${me.status}`);
    assert(me.body.signedIn === false && me.body.signInRequired === false, "not signed in, open");
    assert(me.body.id === SHARED_ID && me.body.name === SHARED_NAME && me.body.role === "EDITOR" && me.body.email === null, `identity ${JSON.stringify(me.body)}`);
    const overview = await anon("/api/m/overview");
    assert(overview.status === 200, `overview ${overview.status}`);
    assert(overview.body.user.signedIn === false && overview.body.user.email === null, "overview user");
    assert(Array.isArray(overview.body.recentActivity) && overview.body.recentActivity.length === 0, "no activity feed for strangers");
  });

  await check("nothing secret in what the open API returns (emails, password or token hashes, device IPs)", async () => {
    const overview = (await anon("/api/m/overview")).body;
    const cab = overview.cabs.find((item) => !item.cabPaused);
    const bodies = [
      JSON.stringify(overview),
      JSON.stringify((await anon("/api/m/loops")).body),
      JSON.stringify((await anon(`/api/m/cabs/${cab.id}`)).body),
      JSON.stringify((await anon(`/api/devices/${cab.id}/enable`, { method: "POST", json: {} })).body),
    ];
    for (const text of bodies) {
      assert(!/passwordHash|apiTokenHash|sessionVersion|"ipAddress"|hpTaxiCabId/.test(text), `no secrets: ${text.slice(0, 200)}`);
      assert(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(text), "no email addresses");
    }
    const pause = (await anon(`/api/devices/${cab.id}/enable`, { method: "POST", json: {} })).body;
    assert(Object.keys(pause).sort().join(",") === "disabledReason,id,isDisabled", `anonymous pause answer is minimal: ${Object.keys(pause)}`);
  });

  await check("search engines: noindex on /m pages and their API, robots.txt disallows, manifest and icons unaffected", async () => {
    for (const url of ["/m", "/m/account", "/api/m/overview", "/api/m/loops", "/api/auth/me", "/api/m/upload?name=x&filename=a.mov"]) {
      const response = await anon(url);
      assert((response.headers.get("x-robots-tag") ?? "").includes("noindex"), `${url} X-Robots-Tag: ${response.headers.get("x-robots-tag")}`);
    }
    const html = (await anon("/m")).body;
    assert(/<meta name="robots" content="[^"]*noindex/.test(html), "robots meta tag on /m");
    const robots = await anon("/robots.txt");
    assert(robots.status === 200 && /User-Agent: \*/i.test(robots.body) && /Disallow: \/\s*$/m.test(robots.body), `robots.txt: ${robots.body}`);
    const manifest = await anon("/m-app/manifest.webmanifest");
    assert(manifest.status === 200 && manifest.body.start_url === "/m", "manifest still served");
    for (const icon of [...manifest.body.icons.map((i) => i.src), "/m-app/apple-touch-icon.png", "/m-app/favicon-32.png", "/m-app/windmill-gold.png"]) {
      const res = await fetch(`${BASE}${icon}`);
      assert(res.ok && res.headers.get("content-type").includes("png"), `${icon} is a PNG`);
    }
  });

  await check("team management and passwords refuse anonymous callers at the API", async () => {
    const someone = await db().user.findFirst({ where: { email: EMAIL } });
    const refused = [
      ["/api/users", {}],
      ["/api/users", { method: "POST", json: { name: "Intruder", email: `intruder-${RUN_ID}@example.com`, password: "Password-123", role: "ADMIN" } }],
      [`/api/users/${someone.id}`, { method: "PATCH", json: { password: "Hijacked-123" } }],
      [`/api/users/${someone.id}`, { method: "PATCH", json: { role: "EDITOR" } }],
      [`/api/users/${someone.id}`, { method: "DELETE" }],
      ["/api/auth/password", { method: "POST", json: { currentPassword: "x", newPassword: "Hijacked-123" } }],
    ];
    for (const [url, init] of refused) {
      const response = await anon(url, init);
      assert(response.status === 401, `${init.method ?? "GET"} ${url} -> ${response.status}`);
      assert(!JSON.stringify(response.body).includes("@"), "no user data in the refusal");
    }
    assert((await db().user.count({ where: { email: `intruder-${RUN_ID}@example.com` } })) === 0, "nobody was added");
    const after = await db().user.findFirst({ where: { email: EMAIL } });
    assert(after.passwordHash === someone.passwordHash && after.role === someone.role, "admin account untouched");
    // The team screen asks for sign-in and never calls the API.
    let calledUsers = false;
    page.on("request", (request) => {
      if (request.url().includes("/api/users")) calledUsers = true;
    });
    await goto(page, "/m/account/team");
    await page.getByTestId("team-sign-in").waitFor();
    assert(!calledUsers, "team screen did not ask for the user list");
    await shot(page, "team-signed-out");
  });

  await check("desktop pages and desktop-only API routes still refuse anonymous callers", async () => {
    for (const route of ["/", "/devices", "/loops", "/assets", "/analytics", "/settings", "/devices/new"]) {
      const response = await anon(route, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
      assert(response.status === 307 && (response.headers.get("location") ?? "").includes("/login?next="), `${route} -> ${response.status} ${response.headers.get("location")}`);
    }
    const cab = (await anon("/api/m/overview")).body.cabs[0];
    const group = (await anon("/api/m/overview")).body.groups[0];
    const closed = [
      ["GET", "/api/devices"],
      ["POST", "/api/devices", { serialNumber: `E2E-${RUN_ID}` }],
      ["PATCH", `/api/devices/${cab.id}`, { notes: "x" }],
      ["DELETE", `/api/devices/${cab.id}`],
      ["PUT", `/api/devices/${cab.id}/disable`, { reason: "desktop verb" }],
      ["PUT", `/api/devices/${cab.id}/enable`, {}],
      ["PUT", "/api/devices/disable-all", { reason: "x" }],
      ["POST", "/api/devices/disable-all", { reason: "x" }],
      ["PUT", "/api/devices/enable-all", {}],
      ["POST", "/api/devices/enable-all", {}],
      ["GET", "/api/settings"],
      ["PUT", "/api/settings", {}],
      ["GET", "/api/loops"],
      ["POST", "/api/loops", { name: "x" }],
      ["POST", "/api/loops/direct-upload?name=xx&filename=a.mov"],
      ["GET", "/api/assets"],
      ["GET", "/api/analytics/overview"],
      ["GET", "/api/analytics/export"],
      ["GET", "/api/device-groups"],
      ["PATCH", `/api/device-groups/${group.id}`, { name: "x" }],
    ];
    for (const [method, url, json] of closed) {
      const response = await anon(url, { method, ...(json ? { json } : {}) });
      assert(response.status === 401, `${method} ${url} -> ${response.status}`);
    }
    assert((await db().device.count({ where: { serialNumber: `E2E-${RUN_ID}` } })) === 0, "no device registered");
  });

  // ---------------------------------------------------------------- home
  const overview = (await anon("/api/m/overview")).body;
  const cabBySerial = Object.fromEntries(overview.cabs.map((cab) => [cab.serialNumber, cab]));
  const loopsByName = Object.fromEntries((await anon("/api/m/loops")).body.items.map((loop) => [loop.name, loop]));
  const theatre = loopsByName["Demo · Theatre week"];
  const spring = loopsByName["Demo · Spring campaign"];
  const portrait = loopsByName["Demo · Portrait phone clip"];
  assert(theatre && spring && portrait, "demo loops exist");

  await check("change times follow each cab's software (1.1.0: one heartbeat; older: 30 minutes)", async () => {
    const lagOf = (serial) => cabBySerial[serial].changeLagMinutes;
    assert(lagOf("DEMO-CAB-01") === 5, `1.1.0 cab lag ${lagOf("DEMO-CAB-01")}`);
    assert(lagOf("DEMO-CAB-04") === 30 && lagOf("DEMO-CAB-02") === 30, "1.0.0 cabs lag 30");
    assert(overview.changeLagMinutes === 30, `fleet worst case ${overview.changeLagMinutes}`);
    assert(overview.changeLag.minMinutes === 5 && overview.changeLag.maxMinutes === 30, `range ${JSON.stringify(overview.changeLag)}`);
    const detail = (await anon(`/api/m/cabs/${cabBySerial["DEMO-CAB-04"].id}`)).body;
    assert(detail.firmwareVersion === "1.0.0" && detail.changeLagMinutes === 30, "detail carries firmware and lag");
  });

  await check("home shows screens on, what plays and every cab", async () => {
    await goto(page, "/m");
    await page.getByTestId("cab-list").waitFor();
    const on = Number(await page.getByTestId("on-count").textContent());
    assert(on === overview.counts.online + overview.counts.updating, `on-count ${on}`);
    assert((await page.getByTestId("cab-row").count()) === overview.cabs.length, "one row per cab");
    assert((await page.getByTestId("fleet-loop").textContent()).includes(spring.name), "fleet plays Spring");
    await shot(page, "home-full", { fullPage: true });
    await page.getByRole("tab", { name: /^Off/ }).click();
    await shot(page, "home-filter-off");
    await page.getByRole("tab", { name: /^All/ }).click();
  });

  // ---------------------------------------------------------------- cab detail
  await check("cab detail: GPS cab with timeline, location and technical details", async () => {
    await page.locator('[data-testid="cab-row"]', { hasText: "LX21 KCB" }).click();
    await page.waitForURL(/\/m\/cabs\//);
    await page.getByTestId("cab-head").waitFor();
    assert((await page.getByTestId("cab-head").textContent()).includes("LX21 KCB"), "plate shown");
    await page.getByTestId("timeline").waitFor();
    assert((await page.getByTestId("cab-location-text").textContent()).includes("GPS position"), "GPS wording");
    await page.locator('[data-testid="cab-map"] [data-testid="map-marker"]').first().waitFor();
    await shot(page, "cab-gps");
    await page.locator('[data-testid="tech-details"] summary').click();
    await page.getByTestId("tech-details").scrollIntoViewIfNeeded();
    await shot(page, "cab-technical");
    await page.locator(".m-back").click();
    await page.waitForURL(/\/m$/);
  });

  await check("cab detail: cell-tower cab reads as approximate; never-seen cab says so", async () => {
    await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-02"].id}`);
    await page.getByTestId("cab-location-text").waitFor();
    assert((await page.getByTestId("cab-location-text").textContent()).includes("Approximate area"), "approximate wording");
    await page.locator('[data-testid="cab-map"] [data-approx="true"]').waitFor();
    await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-07"].id}`);
    await page.getByTestId("cab-location-text").waitFor();
    assert((await page.getByTestId("cab-location-text").textContent()).includes("hasn’t reported"), "no position wording");
    await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-04"].id}`);
    await page.getByTestId("cab-pending").waitFor();
    assert((await page.getByTestId("cab-pending").textContent()).includes("within about 30 minutes"), "old-firmware cab: 30 minutes");
    await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-06"].id}`);
    await page.getByTestId("resume-cab").waitFor();
  });

  // ---------------------------------------------------------------- map
  await check("map shows a marker per located cab (tiles blocked)", async () => {
    await tab(page, "Map").click();
    await page.waitForURL(/\/m\/map/);
    const located = overview.cabs.filter((cab) => cab.location);
    await page.locator('[data-testid="cab-map"] [data-testid="map-marker"]').first().waitFor();
    await page.waitForTimeout(500);
    const markers = await page.locator('[data-testid="cab-map"] [data-testid="map-marker"]').count();
    assert(markers === located.length, `markers ${markers} vs ${located.length}`);
    assert((await page.locator('[data-testid="cab-map"] [data-approx="true"]').count()) === located.filter((c) => c.location.source === "cell").length, "approx markers");
    await page.getByTestId("tiles-failed").waitFor({ timeout: 15_000 });
    await shot(page, "map");
    await page.locator('[data-testid="map-marker"]', { hasText: "LX21 KCB" }).dispatchEvent("click");
    await page.getByTestId("map-card").waitFor();
    await page.getByTestId("map-missing").click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
  });

  // ---------------------------------------------------------------- change: all cabs
  await check("without signing in: switch what all cabs play, confirm with real cab count, reflected and served", async () => {
    await tab(page, "Cabs").click();
    await page.waitForURL(/\/m$/);
    await page.getByTestId("change-fleet").click();
    await page.getByTestId("choose-video-list").waitFor();
    await page.locator(`[data-testid="choose-video"][data-loop-id="${theatre.id}"]`).click();
    await page.getByTestId("confirm-card").waitFor();
    const fresh = (await anon("/api/m/overview")).body;
    const following = fresh.cabs.filter((cab) => cab.expectedSource === "fleet").length;
    const countText = await page.getByTestId("impact-count").textContent();
    assert(countText.includes(`This changes ${following} cab`), `impact text "${countText}" vs ${following}`);
    assert((await page.getByTestId("confirm-question").textContent()).includes("all cabs"), "question names all cabs");
    assert((await page.getByTestId("confirm-change").textContent()).includes(`${following} cab`), "button states count");
    const changingOn = fresh.cabs.filter(
      (cab) => cab.expectedSource === "fleet" && ["online", "updating"].includes(cab.status) && cab.playing?.id !== theatre.id,
    );
    const lags = [...new Set(changingOn.map((cab) => cab.changeLagMinutes))].sort((a, b) => a - b);
    const impactText = await page.getByTestId("impact").textContent();
    if (lags.length > 1) {
      assert(impactText.includes(`within about ${lags[0]} minutes, or up to ${lags.at(-1)} minutes for cabs on older software`), `mixed lag wording: ${impactText}`);
    } else if (lags.length === 1) {
      assert(impactText.includes(`within about ${lags[0]} minutes`), `lag wording: ${impactText}`);
    }
    await shot(page, "change-confirm-fleet", { fullPage: true });
    await page.getByTestId("confirm-change").click();
    await page.getByTestId("change-done").waitFor();
    assert((await page.getByTestId("done-summary").textContent()).includes(`${following} cab`), "done count from the server");
    const served = await manifestFor("DEMO-CAB-08"); // City group, follows all cabs
    assert(served.loopId === theatre.id, `DEMO-CAB-08 served ${served.loopId}`);
    await npm("demo:heartbeat");
    await page.waitForFunction(() => /^[1-9]/.test(document.querySelector('[data-testid="done-progress"]')?.textContent ?? ""), null, { timeout: 40_000 });
    await shot(page, "change-done-fleet-progress");
    await page.getByTestId("done-home").click();
    await page.waitForURL(/\/m$/);
    await page.waitForFunction((name) => document.querySelector('[data-testid="fleet-loop"]')?.textContent?.includes(name), theatre.name);
  });

  // ---------------------------------------------------------------- change: one cab, then back
  const cab08 = cabBySerial["DEMO-CAB-08"];
  await check("without signing in: give one cab its own video, then return it to its group", async () => {
    await goto(page, `/m/cabs/${cab08.id}`);
    await page.getByTestId("change-cab").click();
    await page.locator(`[data-testid="choose-video"][data-loop-id="${portrait.id}"]`).click();
    await page.getByTestId("confirm-card").waitFor();
    assert((await page.getByTestId("impact-count").textContent()).includes("This changes 1 cab"), "one cab");
    assert((await page.getByTestId("confirm-question").textContent()).includes("LV20 MRK"), "names the cab");
    await page.getByTestId("confirm-change").click();
    await page.getByTestId("change-done").waitFor();
    assert((await manifestFor("DEMO-CAB-08")).loopId === portrait.id, "cab served its own video");
    await goto(page, `/m/cabs/${cab08.id}`);
    await page.getByTestId("cab-inherit").waitFor();
    await page.getByTestId("cab-inherit").click();
    await page.getByTestId("confirm-card").waitFor();
    assert((await page.getByTestId("confirm-question").textContent()).includes("back on"), "go-back wording");
    await page.getByTestId("confirm-change").click();
    await page.getByTestId("change-done").waitFor();
    assert((await manifestFor("DEMO-CAB-08")).loopId === theatre.id, "cab back on its group's (all cabs) video");
  });

  await check("without signing in: a group uses the same as all cabs", async () => {
    const westEnd = overview.groups.find((group) => group.name === "Demo · West End");
    await goto(page, "/m");
    await page.locator(`[data-testid="group-row"][data-group-id="${westEnd.id}"]`).click();
    await page.getByTestId("choose-inherit").waitFor();
    await page.getByTestId("choose-inherit").click();
    await page.getByTestId("confirm-card").waitFor();
    await page.getByTestId("confirm-change").click();
    await page.getByTestId("change-done").waitFor();
    assert((await manifestFor("DEMO-CAB-01")).loopId === theatre.id, "West End cab follows all cabs");
  });

  // ---------------------------------------------------------------- upload to a group
  const uploadName = `E2E upload ${RUN_ID}`;
  await check("without signing in: upload a real video to a group and wait until it is ready", async () => {
    const file = await makeVideo(path.join(workDir, "IMG_0042.MOV"));
    const city = overview.groups.find((group) => group.name === "Demo · City");
    await tab(page, "Upload").click();
    await page.waitForURL(/\/m\/upload/);
    await page.getByTestId("upload-file").setInputFiles(file);
    await page.getByTestId("upload-name").fill(uploadName);
    await page.locator(".m-radio", { hasText: `${city.name} group` }).click();
    await page.waitForTimeout(800);
    await page.getByTestId("upload-submit").click();
    await page.getByTestId("upload-confirm").waitFor();
    await page.getByTestId("upload-confirm-go").click();
    await page.waitForFunction(() => ["uploading", "processing", "ready"].includes(document.querySelector('[data-testid="upload-job"]')?.getAttribute("data-phase") ?? ""));
    await tab(page, "Videos").click();
    await page.getByTestId("video-list").waitFor();
    await tab(page, "Upload").click();
    await page.locator('[data-testid="upload-job"][data-phase="ready"]').waitFor({ timeout: 180_000 });
    await shot(page, "upload-ready");
    const items = (await anon("/api/m/loops")).body.items;
    const loop = items.find((item) => item.name === uploadName);
    assert(loop && loop.processing.state === "ready", "uploaded loop ready");
    created.loops.add(loop.id);
    assert(loop.liveOn.groups.some((group) => group.id === city.id), "live on City group");
    assert((await manifestFor("DEMO-CAB-08")).loopId === loop.id, "City cab is served the upload");
    await page.getByTestId("upload-see").click();
    await page.getByTestId("video-title").waitFor();
  });

  await check("a video that is playing can't be removed (explained)", async () => {
    await page.getByTestId("remove-video").click();
    await page.getByTestId("remove-sheet").waitFor();
    assert((await page.getByTestId("remove-sheet").textContent()).includes("Put a different video on those cabs first"), "explains why");
    await page.keyboard.press("Escape");
  });

  // ---------------------------------------------------------------- failed uploads
  await check("failed upload (not a video) shows the reason", async () => {
    const bad = path.join(workDir, "holiday.mp4");
    writeFileSync(bad, "this is not a video, just some text pretending to be one\n".repeat(200));
    await tab(page, "Upload").click();
    const again = page.getByRole("button", { name: /Upload another|Choose a video again/ });
    if (await again.count()) await again.first().click();
    await page.getByTestId("upload-file").setInputFiles(bad);
    await page.getByTestId("upload-name").fill(`E2E not a video ${RUN_ID}`);
    await page.getByTestId("upload-submit").click();
    await page.getByTestId("upload-failed-reason").waitFor({ timeout: 60_000 });
    const reason = await page.getByTestId("upload-failed-reason").textContent();
    assert(/not a supported video/i.test(reason), `reason: ${reason}`);
    await page.getByTestId("upload-retry").click();
  });

  let brokenId = null;
  await check("failed upload during preparation shows the reason here and in Videos", async () => {
    const header = Buffer.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0, 0x71, 0x74, 0x20, 0x20]);
    const broken = path.join(workDir, "broken.mov");
    writeFileSync(broken, Buffer.concat([header, Buffer.alloc(64 * 1024, 7)]));
    await page.getByTestId("upload-file").setInputFiles(broken);
    await page.getByTestId("upload-name").fill(`E2E broken ${RUN_ID}`);
    await page.getByTestId("upload-submit").click();
    await page.getByTestId("upload-failed-reason").waitFor({ timeout: 120_000 });
    const reason = await page.getByTestId("upload-failed-reason").textContent();
    assert(reason && reason.length > 10, `reason: ${reason}`);
    const items = (await anon("/api/m/loops")).body.items;
    const loop = items.find((item) => item.name === `E2E broken ${RUN_ID}`);
    assert(loop && loop.processing.state === "failed", "failed loop listed");
    brokenId = loop.id;
    created.loops.add(loop.id);
    await page.getByTestId("upload-retry").click();
    await tab(page, "Videos").click();
    await page.locator(`[data-testid="video-row"][data-loop-id="${loop.id}"] [data-testid="video-failed-reason"]`).waitFor();
  });

  await check("without signing in: remove a video from the library", async () => {
    await page.locator(`[data-testid="video-row"][data-loop-id="${brokenId}"]`).click();
    await page.getByTestId("video-failed").waitFor();
    await page.getByTestId("remove-video").click();
    await page.getByTestId("remove-confirm").click();
    await page.waitForURL(/\/m\/videos$/);
    await page.getByTestId("video-list").waitFor();
    await page.waitForTimeout(500);
    assert((await page.locator(`[data-testid="video-row"][data-loop-id="${brokenId}"]`).count()) === 0, "removed from list");
  });

  // ---------------------------------------------------------------- pause / resume
  await check("without signing in: pause and resume a cab's screen", async () => {
    const cab = cabBySerial["DEMO-CAB-01"];
    await goto(page, `/m/cabs/${cab.id}`);
    await page.getByTestId("pause-cab").click();
    await page.getByTestId("pause-sheet").waitFor();
    await page.locator('[data-testid="pause-sheet"] input').fill("E2E test");
    await page.getByTestId("pause-confirm").click();
    await page.getByTestId("resume-cab").waitFor();
    assert((await manifestFor("DEMO-CAB-01")).disabled === true, "device told it is paused");
    await page.locator('[data-testid="cab-head"] [data-status="paused"]').waitFor({ timeout: 30_000 });
    await shot(page, "cab-after-pause");
    await page.getByTestId("resume-cab").click();
    await page.getByTestId("pause-confirm").click();
    await page.getByTestId("pause-cab").waitFor();
    assert((await manifestFor("DEMO-CAB-01")).disabled === false, "device resumed");
  });

  const admin = await adminSession();
  await check("all screens paused (from the desktop): a cab explains it and offers no resume that can't work", async () => {
    const paused = await admin("/api/devices/disable-all", { method: "PUT", json: { reason: "E2E fleet pause" } });
    assert(paused.status === 200, `disable-all ${paused.status}`);
    try {
      const cab = cabBySerial["DEMO-CAB-01"];
      const api = (await anon(`/api/m/cabs/${cab.id}`)).body;
      assert(api.fleetPaused === true && api.cabPaused === false && api.isPaused === true, `pause fields ${JSON.stringify([api.fleetPaused, api.cabPaused])}`);
      await goto(page, `/m/cabs/${cab.id}`);
      await page.getByTestId("fleet-paused").waitFor();
      assert((await page.getByTestId("resume-cab").count()) === 0, "no per-cab resume during an all-screens pause");
      assert((await page.getByTestId("fleet-paused").textContent()).includes("can’t be resumed on its own"), "explains why");
    } finally {
      await admin("/api/devices/enable-all", { method: "PUT", json: {} });
    }
  });

  // ---------------------------------------------------------------- activity log
  await check("actions without sign-in are in the activity log as the shared identity, with the request IP", async () => {
    const events = await activitySince(["LOOP_ASSIGNED", "LOOP_ARCHIVED", "DEVICE_DISABLED", "DEVICE_ENABLED", "LOOP_PUBLISHED"]);
    const byType = (type) => events.filter((event) => event.type === type && event.metadata?.userId === SHARED_ID);
    for (const type of ["LOOP_ASSIGNED", "LOOP_ARCHIVED", "DEVICE_DISABLED", "DEVICE_ENABLED", "LOOP_PUBLISHED"]) {
      const found = byType(type);
      assert(found.length > 0, `${type} attributed to ${SHARED_ID}`);
      for (const event of found) {
        assert(event.metadata.anonymous === true && event.metadata.userName === SHARED_NAME, `${type} metadata names the shared identity`);
        assert(typeof event.metadata.ip === "string" && event.metadata.ip.length > 0 && event.metadata.ip !== "unknown", `${type} has the IP (${event.metadata.ip})`);
        assert(event.message.includes(SHARED_NAME), `${type} message: ${event.message}`);
      }
    }
    assert(!events.some((event) => event.type === "LOOP_ASSIGNED" && !event.metadata?.userId), "every change names someone");
  });

  // ---------------------------------------------------------------- freshness, no 401 bounce
  await check("network drop keeps the last data with a quiet notice", async () => {
    await goto(page, "/m");
    await page.getByTestId("cab-list").waitFor();
    await context.setOffline(true);
    await page.getByTestId("freshness").click();
    await page.getByTestId("offline-notice").waitFor();
    assert((await page.getByTestId("cab-row").count()) > 0, "still shows cabs");
    await context.setOffline(false);
    await page.getByTestId("freshness").click();
    await page.getByTestId("offline-notice").waitFor({ state: "detached" });
  });

  // ---------------------------------------------------------------- account: signed out, then admin
  await check("account (not signed in): who you act as and a way to sign in", async () => {
    await tab(page, "Account").click();
    await page.locator('[data-testid="account-card"][data-signed-in="false"]').waitFor();
    assert((await page.getByTestId("account-card").textContent()).includes(SHARED_NAME), "names the shared identity");
    assert((await page.getByTestId("sign-out").count()) === 0 && (await page.getByTestId("account-team").count()) === 0, "no sign out / team rows");
    await shot(page, "account-signed-out");
    await page.getByTestId("account-sign-in").click();
    await page.waitForURL(/\/m\/login\?next=%2Fm%2Faccount$/);
    await page.locator('[data-testid="login-submit"]:not([disabled])').waitFor();
    assert((await page.getByTestId("login-skip").count()) === 1, "can go back without signing in");
    await shot(page, "login");
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', "wrong-password");
    await page.click('[data-testid="login-submit"]');
    await page.getByTestId("login-error").waitFor();
    await login(page, { expectNext: "/m/account" });
    await page.locator('[data-testid="account-card"][data-signed-in="true"]').waitFor();
    await page.getByTestId("account-team").waitFor();
    assert((await page.getByTestId("account-card").textContent()).includes(EMAIL), "shows the admin");
    await shot(page, "account-signed-in-admin");
  });

  const me = (await apiJson(page, "/api/auth/me")).body;
  await check("signed-in changes are still attributed by name", async () => {
    const assigned = await apiJson(page, "/api/m/assign", { method: "POST", data: { loopId: spring.id, target: { type: "fleet" } } });
    assert(assigned.status === 200, `assign ${assigned.status}`);
    assert((await manifestFor("DEMO-CAB-01")).loopId === spring.id, "West End cab (follows all cabs) is served it");
    const [latest] = await activitySince(["LOOP_ASSIGNED"]);
    assert(latest.metadata.userId === me.id && latest.metadata.userName === me.name && !latest.metadata.anonymous, `by name: ${JSON.stringify(latest.metadata)}`);
    assert(latest.message.startsWith(me.name), latest.message);
  });

  await check("uploads are prepared one at a time; an upload whose target changed meanwhile stays in Videos and says why", async () => {
    // Signed in (not limited), so repeated runs do not use up the anonymous upload allowance.
    const city = overview.groups.find((group) => group.name === "Demo · City");
    const slow = await makeVideo(path.join(workDir, "slow.mov"), 60, "1920x1080");
    const quick = await makeVideo(path.join(workDir, "quick.mov"), 3);
    const post = async (name, file, target) => {
      const query = new URLSearchParams({ name, filename: path.basename(file) });
      if (target) query.set("target", JSON.stringify(target));
      const response = await page.request.post(`${BASE}/api/m/upload?${query}`, {
        data: readFileSync(file),
        headers: { "Content-Type": "video/quicktime" },
        timeout: 120_000,
      });
      const body = await response.json();
      assert(response.status() === 202, `upload ${name}: ${response.status()} ${JSON.stringify(body)}`);
      created.loops.add(body.loopId);
      return body.loopId;
    };
    const firstId = await post(`E2E first in line ${RUN_ID}`, slow, null);
    const secondId = await post(`E2E superseded ${RUN_ID}`, quick, { type: "group", groupId: city.id });
    const waiting = (await apiJson(page, `/api/m/loops/${secondId}`)).body;
    assert(waiting.processing.state === "processing" && waiting.processing.waiting === true, `second waits: ${JSON.stringify(waiting.processing)}`);
    await goto(page, `/m/videos/${secondId}`);
    await page.getByText("Waiting its turn").waitFor();
    const assigned = await apiJson(page, "/api/m/assign", { method: "POST", data: { loopId: spring.id, target: { type: "group", groupId: city.id } } });
    assert(assigned.status === 200, `assign ${assigned.status}`);
    let second = null;
    for (let i = 0; i < 120; i += 1) {
      second = (await apiJson(page, `/api/m/loops/${secondId}`)).body;
      if (second.processing.state !== "processing") break;
      await page.waitForTimeout(1500);
    }
    assert(second.processing.state === "ready", `second ready: ${JSON.stringify(second.processing)}`);
    assert(/wasn't put on group Demo · City, because what group Demo · City plays was changed while this video was uploading/.test(second.processing.error ?? ""), `note: ${second.processing.error}`);
    assert(!second.liveOn.groups.some((group) => group.id === city.id) && second.liveOn.cabCount === 0, "not live anywhere");
    assert((await manifestFor("DEMO-CAB-08")).loopId === spring.id, "City keeps the newer choice");
    const first = (await apiJson(page, `/api/m/loops/${firstId}`)).body;
    assert(first.processing.state === "ready" && first.liveOn.cabCount === 0, "first upload ready, in Videos only");
  });

  await check("signed in: change password", async () => {
    await goto(page, "/m/account");
    await page.getByTestId("account-password").click();
    await page.locator('input[name="current"]').waitFor();
    // The dev server may reload a page it has just compiled; let that settle before typing.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const temp = `Tmp-${RUN_ID}-pw`;
    await page.fill('input[name="current"]', PASSWORD);
    await page.fill('input[name="next"]', temp);
    await page.fill('input[name="repeat"]', temp);
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByTestId("password-done").waitFor();
    assert((await apiJson(page, "/api/settings")).status === 200, "still signed in after own password change");
    await page.fill('input[name="current"]', temp);
    await page.fill('input[name="next"]', PASSWORD);
    await page.fill('input[name="repeat"]', PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await page.getByTestId("password-done").waitFor();
    await page.locator(".m-back").click();
  });

  const tester = { name: `E2E Tester ${RUN_ID}`, email: `e2e-${RUN_ID}@example.com` };
  await check("signed-in admin: team screen add, change role, reset password, remove", async () => {
    await page.getByTestId("account-team").click();
    await page.getByTestId("team-list").waitFor();
    await shot(page, "team");
    await page.getByTestId("team-add").click();
    await page.getByTestId("team-add-name").fill(tester.name);
    await page.getByTestId("team-add-email").fill(tester.email);
    await page.getByTestId("team-add-password").fill("Welcome-123");
    await page.getByTestId("team-add-submit").click();
    const row = page.locator(`[data-testid="team-member"][data-email="${tester.email}"]`);
    await row.waitFor();
    created.users.add(tester.email);
    assert((await row.textContent()).includes("Editor"), "added as editor");
    await row.click();
    await page.getByTestId("team-edit-sheet").waitFor();
    await page.locator('[data-testid="team-edit-sheet"] .m-segmented label', { hasText: "Admin" }).click();
    await page.getByTestId("team-save-role").click();
    await page.getByTestId("team-message").waitFor();
    await page.getByTestId("team-reset-password").fill("Another-456");
    await page.getByTestId("team-save-password").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="team-message"]')?.textContent?.includes("Password reset"));
    await page.keyboard.press("Escape");
    assert((await row.textContent()).includes("Admin"), "role changed to admin");
    await row.click();
    await page.getByTestId("team-remove").click();
    await page.getByTestId("team-remove-confirm").click();
    await row.waitFor({ state: "detached" });
    created.users.delete(tester.email);
  });

  await check("a reset or removed teammate's session stops counting as them everywhere", async () => {
    const mate = { name: `E2E Mate ${RUN_ID}`, email: `e2e-mate-${RUN_ID}@example.com`, password: "Welcome-123" };
    const made = await apiJson(page, "/api/users", { method: "POST", data: { ...mate, role: "EDITOR" } });
    assert(made.status === 200 || made.status === 201, `create ${made.status}`);
    created.users.add(mate.email);
    const other = await newPhoneContext(browser);
    try {
      const mp = await other.newPage();
      const signIn = async (password) => {
        const response = await mp.request.post(`${BASE}/api/auth/login`, { data: { email: mate.email, password } });
        assert(response.ok(), `teammate login ${response.status()}`);
      };
      await signIn(mate.password);
      const status = async (url, init) => (await apiJson(mp, url, init)).status;
      assert((await status("/api/settings")) === 200, "teammate signed in");
      assert((await apiJson(mp, "/api/auth/me")).body.signedIn === true, "me: signed in");
      // An editor cannot manage the team either.
      assert((await status("/api/users")) === 403, "editor refused team list");
      const reset = await apiJson(page, `/api/users/${made.body.id}`, { method: "PATCH", data: { password: "Another-456" } });
      assert(reset.status === 200, `reset ${reset.status}`);
      assert((await status("/api/settings")) === 401, "old session refused on settings");
      assert((await status("/api/loops")) === 401, "old session refused on loops");
      assert((await status(`/api/devices/${cabBySerial["DEMO-CAB-03"].id}/disable`, { method: "PUT", data: { reason: "x" } })) === 401, "old session cannot use the desktop pause");
      // The open phone app still works for them, but no longer as them.
      const after = (await apiJson(mp, "/api/auth/me")).body;
      assert(after.signedIn === false && after.id === SHARED_ID, `revoked session acts as the shared identity: ${JSON.stringify(after)}`);
      await signIn("Another-456");
      assert((await status("/api/loops")) === 200, "new session works");
      const removed = await apiJson(page, `/api/users/${made.body.id}`, { method: "DELETE" });
      assert(removed.status === 200, `delete ${removed.status}`);
      created.users.delete(mate.email);
      assert((await status("/api/loops")) === 401 && (await status(`/api/devices/${cabBySerial["DEMO-CAB-03"].id}`)) === 401, "removed user refused");
    } finally {
      await other.close();
    }
  });

  await check("a lost session does not bounce the phone app to sign-in", async () => {
    await goto(page, "/m/videos");
    await page.getByTestId("video-list").waitFor();
    const cookies = await context.cookies();
    await context.clearCookies();
    await page.getByTestId("freshness").click();
    await page.waitForTimeout(1500);
    assert(new URL(page.url()).pathname === "/m/videos", `stayed on videos (${page.url()})`);
    await context.addCookies(cookies);
  });

  await check("sign out: back to using the app without signing in", async () => {
    await goto(page, "/m/account");
    await page.locator('[data-testid="account-card"][data-signed-in="true"]').waitFor();
    await page.waitForLoadState("networkidle");
    await page.getByTestId("sign-out").click();
    await page.locator('[data-testid="account-card"][data-signed-in="false"]').waitFor();
    assert(new URL(page.url()).pathname === "/m/account", `stays in the app (${page.url()})`);
    await goto(page, "/m");
    await page.getByTestId("cab-list").waitFor();
    assert(!page.url().includes("/login"), "no sign-in screen");
    await context.close();
  });

  // ---------------------------------------------------------------- desktop
  await check("desktop site: still signs in and renders", async () => {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await desktop.route((url) => url.hostname !== new URL(BASE).hostname, (route) => route.abort());
    const desk = await desktop.newPage();
    await desk.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await desk.waitForURL(/\/login/);
    await desk.fill('input[name="email"]', EMAIL);
    await desk.fill('input[name="password"]', PASSWORD);
    await desk.click('button[type="submit"]');
    await desk.waitForURL(`${BASE}/`, { waitUntil: "domcontentloaded" });
    for (const route of ["/", "/devices", "/loops"]) {
      await desk.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await desk.locator(".sidebar").waitFor();
      await desk.waitForTimeout(800);
      assert(!(await desk.locator("text=Application error").count()), `${route} renders`);
    }
    await shot(desk, "desktop-dashboard");
    await desktop.close();
  });

  // ---------------------------------------------------------------- small phone
  await check("small phone (375x667) screens, no sign-in", async () => {
    const small = await newPhoneContext(browser, devices["iPhone SE"], { viewport: { width: 375, height: 667 } });
    const sp = await small.newPage();
    await sp.goto(`${BASE}/m`, { waitUntil: "domcontentloaded" });
    await sp.getByTestId("cab-list").waitFor();
    await shot(sp, "small-home");
    await sp.goto(`${BASE}/m/change?target=fleet&loop=${spring.id}`, { waitUntil: "domcontentloaded" });
    await sp.getByTestId("confirm-card").waitFor();
    await sp.goto(`${BASE}/m/account`, { waitUntil: "domcontentloaded" });
    await sp.locator('[data-testid="account-card"][data-signed-in="false"]').waitFor();
    await sp.goto(`${BASE}/m/login?next=%2Fm%2Faccount`, { waitUntil: "domcontentloaded" });
    await sp.locator('[data-testid="login-submit"]:not([disabled])').waitFor();
    await shot(sp, "small-login");
    const overlap = await sp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert(!overlap, "no horizontal scroll");
    await small.close();
  });

  // ---------------------------------------------------------------- PWA bits
  await check("installable: manifest, icons and iOS meta", async () => {
    const response = await fetch(`${BASE}/m-app/manifest.webmanifest`);
    const manifest = await response.json();
    assert(manifest.start_url === "/m" && manifest.display === "standalone", "manifest start_url/display");
    const html = await (await fetch(`${BASE}/m`)).text();
    for (const needle of ['rel="manifest"', "apple-touch-icon", "apple-mobile-web-app-capable", "black-translucent", "viewport-fit=cover", 'name="theme-color"']) {
      assert(html.includes(needle), `head has ${needle}`);
    }
  });
}

// ================================================================== anonymous upload ceiling

async function uploadCeilingSuite(browser, base) {
  assert((await serverMode(base)) === "open", "extra server is open");
  const query = (name) => `/api/m/upload?${new URLSearchParams({ name, filename: "clip.mov" })}`;
  const notAVideo = "definitely not a video\n".repeat(50);

  await check("anonymous upload ceiling: 3 per hour on the test server, then a clear refusal", async () => {
    assert((await anon(query("E2E ceiling"), {}, base)).status === 200, "preflight allowed at first");
    // Each POST counts as soon as the server starts receiving it (these are refused as not-a-video).
    for (let i = 0; i < 3; i += 1) {
      const response = await anon(query(`E2E ceiling ${i}`), { method: "POST", body: notAVideo, headers: { "Content-Type": "video/quicktime" } }, base);
      assert(response.status === 415, `upload ${i}: ${response.status} ${JSON.stringify(response.body)}`);
    }
    const refused = await anon(query("E2E ceiling 4"), { method: "POST", body: notAVideo, headers: { "Content-Type": "video/quicktime" } }, base);
    assert(refused.status === 429, `4th upload ${refused.status}`);
    assert(/3 video uploads in the last hour/.test(refused.body.error) && /Try again in \d+ minutes?/.test(refused.body.error), refused.body.error);
    const preflight = await anon(query("E2E ceiling 5"), {}, base);
    assert(preflight.status === 429, `preflight refused too: ${preflight.status}`);
    // Signed-in users are not limited.
    const admin = await adminSession(base);
    assert((await admin(query("E2E ceiling admin"), {})).status === 200, "admin preflight allowed");
    const adminPost = await admin(query("E2E ceiling admin"), { method: "POST", body: notAVideo, headers: { "Content-Type": "video/quicktime" } });
    assert(adminPost.status === 415, `admin upload reaches the file check: ${adminPost.status}`);
  });

  await check("anonymous upload ceiling: the phone says so before sending anything", async () => {
    const context = await newPhoneContext(browser, devices["iPhone 14"], {}, base);
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);
      const file = await makeVideo(path.join(workDir, "ceiling.mov"));
      let posted = false;
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().includes("/api/m/upload")) posted = true;
      });
      await goto(page, "/m/upload", base);
      // A fresh dev server may reload a page it has just compiled; let that settle first.
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);
      await page.getByTestId("upload-file").setInputFiles(file);
      await page.getByTestId("upload-name").fill(`E2E ceiling UI ${RUN_ID}`);
      await page.getByTestId("upload-submit").click();
      const confirm = page.getByTestId("upload-confirm-go");
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await page.getByTestId("upload-failed-reason").waitFor();
      const reason = await page.getByTestId("upload-failed-reason").textContent();
      assert(/video uploads in the last hour/.test(reason) && /sign in/.test(reason), `reason: ${reason}`);
      assert(!posted, "the video was not sent");
      await shot(page, "upload-ceiling");
    } finally {
      await context.close();
    }
  });
}

// ========================================================== PHONE_APP_REQUIRE_SIGN_IN=true

async function signInRequiredSuite(browser, base) {
  assert((await serverMode(base)) === "sign-in-required", "server requires sign-in");
  await check("sign-in required: the phone API refuses anonymous callers again", async () => {
    const overview = await anon("/api/m/overview", {}, base);
    assert(overview.status === 401, `overview ${overview.status}`);
    assert((await anon("/api/auth/me", {}, base)).status === 401, "me 401");
    assert((await anon("/api/m/loops", {}, base)).status === 401, "loops 401");
    assert((await anon("/api/m/assign", { method: "POST", json: { loopId: null, target: { type: "fleet" } } }, base)).status === 401, "assign 401");
    assert((await anon("/api/m/upload?name=xx&filename=a.mov", {}, base)).status === 401, "upload preflight 401");
    const admin = await adminSession(base);
    const cab = (await admin("/api/m/overview")).body.cabs[0];
    assert((await anon(`/api/devices/${cab.id}/disable`, { method: "POST", json: { reason: "x" } }, base)).status === 401, "pause 401");
    assert((await admin(`/api/m/cabs/${cab.id}`)).body.cabPaused === false, "cab was not paused");
  });

  const context = await newPhoneContext(browser, devices["iPhone 14"], {}, base);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  try {
    await check("sign-in required: /m/videos redirects to sign-in and back", async () => {
      await goto(page, "/m/videos", base);
      await page.waitForURL(/\/m\/login\?next=%2Fm%2Fvideos/);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);
      await page.locator('[data-testid="login-submit"]:not([disabled])').waitFor();
      assert((await page.getByTestId("login-skip").count()) === 0, "no way round it");
      assert((await page.locator(".m-login-brand p").textContent()).includes("Sign in to see and change what plays"), "old wording");
      await shot(page, "login-sign-in-required");
      await page.fill('input[name="email"]', EMAIL);
      await page.fill('input[name="password"]', "wrong-password");
      await page.click('[data-testid="login-submit"]');
      await page.getByTestId("login-error").waitFor();
      await login(page, { expectNext: "/m/videos" });
      await page.getByTestId("video-list").waitFor();
    });

    await check("sign-in required: signed in, a change is made and served, and recorded by name", async () => {
      const me = (await apiJson(page, `${base}/api/auth/me`)).body;
      assert(me.signedIn === true && me.signInRequired === true, `me ${JSON.stringify(me)}`);
      const overview = (await apiJson(page, `${base}/api/m/overview`)).body;
      const theatre = (await apiJson(page, `${base}/api/m/loops`)).body.items.find((loop) => loop.name === "Demo · Theatre week");
      const cab = overview.cabs.find((item) => item.serialNumber === "DEMO-CAB-08");
      const assigned = await apiJson(page, `${base}/api/m/assign`, { method: "POST", data: { loopId: theatre.id, target: { type: "cab", deviceId: cab.id } } });
      assert(assigned.status === 200, `assign ${assigned.status}`);
      assert((await manifestFor("DEMO-CAB-08", base)).loopId === theatre.id, "served");
      const [latest] = await activitySince(["LOOP_ASSIGNED"]);
      assert(latest.metadata.userId === me.id && !latest.metadata.anonymous, "by name");
      await apiJson(page, `${base}/api/m/assign`, { method: "POST", data: { loopId: null, target: { type: "cab", deviceId: cab.id } } });
      await goto(page, "/m/account", base);
      await page.locator('[data-testid="account-card"][data-signed-in="true"]').waitFor();
    });

    await check("sign-in required: a 401 from the API sends the user to sign in", async () => {
      await goto(page, "/m/videos", base);
      await page.getByTestId("video-list").waitFor();
      const cookies = await context.cookies();
      await context.clearCookies();
      await page.getByTestId("freshness").click();
      await page.waitForURL(/\/m\/login\?next=%2Fm%2Fvideos/);
      await context.addCookies(cookies);
    });

    await check("sign-in required: sign out goes to the sign-in screen; a phone at the root is sent to sign in", async () => {
      await goto(page, "/m/account", base);
      await page.locator('[data-testid="account-card"][data-signed-in="true"]').waitFor();
      await page.waitForLoadState("networkidle");
      await page.getByTestId("sign-out").click();
      await page.waitForURL(/\/m\/login/, { waitUntil: "domcontentloaded" });
      await goto(page, "/m", base);
      await page.waitForURL(/\/m\/login\?next=%2Fm/);
      await goto(page, "/", base);
      await page.waitForURL(/\/m\/login\?next=%2Fm$/);
    });
  } finally {
    await context.close();
  }
}

// ============================================================================ icon contact sheet

async function iconContactSheet(browser) {
  const dir = path.join(webDir, "public/m-app");
  const data = (name) => `data:image/png;base64,${readFileSync(path.join(dir, name)).toString("base64")}`;
  const files = ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "favicon-64.png", "favicon-32.png", "windmill-gold.png"];
  const sizeOf = (name) => {
    const buffer = readFileSync(path.join(dir, name));
    return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
  };
  // The sheet is captured at deviceScaleFactor 2: an image drawn at N/2 CSS px shows its N pixels
  // one-to-one. "Home Screen" rows draw the 180px apple-touch-icon the way an iPhone does: 60pt,
  // i.e. 120 px on a 2x phone (60 CSS px here) and 60 px on a 1x screen (30 CSS px here).
  const tile = (src, cssSize, label, extra = "") =>
    `<figure><img src="${src}" style="width:${cssSize}px;height:${cssSize}px;${extra}"><figcaption>${label}</figcaption></figure>`;
  const ios = "border-radius:22.5%;";
  const native = files
    .map((name) => {
      const { w, h } = sizeOf(name);
      return `<figure><img src="${data(name)}" style="width:${w / 2}px;height:${h / 2}px;${name === "windmill-gold.png" ? "background:#0a101c;" : ""}"><figcaption>${name}<br>${w}x${h} (1:1)</figcaption></figure>`;
    })
    .join("");
  const homeRow = (label) =>
    [
      tile(data("apple-touch-icon.png"), 60, `${label}<br>60pt @2x = 120x120`, ios),
      tile(data("apple-touch-icon.png"), 30, `${label}<br>60x60 px`, ios),
      tile(data("apple-touch-icon.png"), 90, `${label}<br>60pt @3x = 180x180`, ios),
      tile(data("icon-maskable-512.png"), 60, "maskable, circle mask<br>120x120", "border-radius:50%;"),
      tile(data("favicon-32.png"), 8, "favicon 16x16"),
      tile(data("favicon-32.png"), 16, "favicon-32"),
    ].join("");
  const html = `<!doctype html><html><head><style>
    body{margin:0;font:12px/1.35 -apple-system,Segoe UI,sans-serif;background:#e9ecf1;color:#222}
    h2{font-size:14px;margin:0 0 10px}
    section{padding:16px 18px}
    .row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:22px}
    figure{margin:0;display:grid;justify-items:center;gap:6px;text-align:center}
    .light{background:linear-gradient(135deg,#f6d9c8,#cfe3f7 55%,#e9f3d9)}
    .dark{background:linear-gradient(135deg,#0d1b2a,#2b1d3a 55%,#08121c);color:#ddd}
    .native{background:#ffffff}
    .safe{position:relative}
    .safe::after{content:"";position:absolute;inset:10%;border-radius:50%;outline:1px dashed #f33}
  </style></head><body>
    <section class="light"><h2>Home Screen, light wallpaper</h2><div class="row">${homeRow("apple-touch-icon")}</div></section>
    <section class="dark"><h2>Home Screen, dark wallpaper</h2><div class="row">${homeRow("apple-touch-icon")}</div></section>
    <section class="native"><h2>Every generated file at its own size (1:1 pixels)</h2><div class="row">${native}</div></section>
    <section class="native"><h2>Maskable icon with the 80% safe zone</h2><div class="row"><figure class="safe"><img src="${data("icon-maskable-512.png")}" style="width:256px;height:256px"></figure>
      ${tile(data("icon-maskable-512.png"), 128, "squircle mask", "border-radius:30%;")}${tile(data("icon-maskable-512.png"), 128, "circle mask", "border-radius:50%;")}</div></section>
  </body></html>`;
  const context = await browser.newContext({ viewport: { width: 980, height: 600 }, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    await page.setContent(html);
    await page.waitForTimeout(200);
    step += 1;
    await page.screenshot({ path: path.join(SHOTS, `${String(step).padStart(2, "0")}-icon-contact-sheet.png`), fullPage: true });
  } finally {
    await context.close();
  }
}

async function cleanup() {
  console.log("- restoring demo data ...");
  try {
    await npm("demo:seed");
    // Clear the cab override this run may have left and archive the videos it uploaded.
    const admin = await adminSession();
    const loops = (await admin("/api/m/loops")).body;
    for (const loop of loops.items ?? []) {
      if (loop.name.includes(RUN_ID) || created.loops.has(loop.id)) {
        await admin(`/api/m/loops/${loop.id}/archive`, { method: "POST" });
      }
    }
    const users = (await admin("/api/users")).body;
    for (const user of users.items ?? []) {
      if (user.email.startsWith("e2e-")) await admin(`/api/users/${user.id}`, { method: "DELETE" });
    }
    await npm("demo:heartbeat");
    console.log("  done");
  } catch (error) {
    console.log(`  cleanup problem: ${error.message}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    await prismaClient?.$disconnect().catch(() => undefined);
  }
}

main()
  .then(() => {
    const failed = results.filter((result) => !result.ok);
    const skipped = results.filter((result) => result.skipped);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped.length ? ` (${skipped.length} skipped)` : ""}. Screenshots: ${SHOTS}`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch((error) => {
    console.log(`\nE2E FAILED: ${error.message}`);
    process.exit(1);
  });
