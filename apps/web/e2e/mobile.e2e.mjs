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

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const BASE = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SHOTS = process.env.SHOTS_DIR ?? path.join(here, "shots");
const EMAIL = process.env.E2E_EMAIL ?? "admin@orisonscreens.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "ChangeMe123!";
const DEVICE_TOKEN = process.env.DEVICE_SHARED_TOKEN ?? "local-device-token";
const RUN_ID = Date.now().toString(36);

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
async function manifestFor(serial) {
  const response = await fetch(`${BASE}/api/devices/manifest`, {
    headers: { "X-Device-Serial": serial, Authorization: `Bearer ${DEVICE_TOKEN}` },
  });
  const body = await response.json();
  assert(response.ok, `manifest for ${serial}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function apiJson(page, url, init) {
  const response = init ? await page.request.fetch(`${BASE}${url}`, init) : await page.request.get(`${BASE}${url}`);
  return { status: response.status(), body: await response.json().catch(() => null) };
}

function tab(page, name) {
  return page.locator(".m-tabbar").getByRole("link", { name, exact: true });
}

async function goto(page, url) {
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
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

async function newPhoneContext(browser, device = devices["iPhone 14"], extra = {}) {
  const context = await browser.newContext({ ...device, deviceScaleFactor: 2, locale: "en-GB", timezoneId: "Europe/London", ...extra });
  // Block every external host (map tiles, web fonts): the app must still work.
  await context.route((url) => url.hostname !== new URL(BASE).hostname, (route) => route.abort());
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

// ------------------------------------------------------------------------------------------ test

const created = { loops: new Set(), users: new Set() };

async function main() {
  await loadEnvFile();
  console.log(`Orison mobile e2e against ${BASE}; screenshots in ${SHOTS}`);
  await check("reset demo data and bring live cabs online", async () => {
    await npm("demo:seed");
    await npm("demo:heartbeat");
  });

  const browser = await chromium.launch();
  let page;
  try {
    const context = await newPhoneContext(browser);
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => console.log(`  [pageerror] ${error.message}`));

    // ---------------------------------------------------------------- sign in
    await check("unauthenticated /m/videos redirects to sign-in and back", async () => {
      await goto(page, "/m/videos");
      await page.waitForURL(/\/m\/login\?next=%2Fm%2Fvideos/);
      await page.locator('[data-testid="login-submit"]:not([disabled])').waitFor();
      await shot(page, "login");
      await page.fill('input[name="email"]', EMAIL);
      await page.fill('input[name="password"]', "wrong-password");
      await page.click('[data-testid="login-submit"]');
      await page.getByTestId("login-error").waitFor();
      await shot(page, "login-error");
      await login(page, { expectNext: "/m/videos" });
      await page.getByTestId("video-list").waitFor();
    });

    // ---------------------------------------------------------------- home
    const overview = (await apiJson(page, "/api/m/overview")).body;
    const cabBySerial = Object.fromEntries(overview.cabs.map((cab) => [cab.serialNumber, cab]));
    const loopsByName = Object.fromEntries((await apiJson(page, "/api/m/loops")).body.items.map((loop) => [loop.name, loop]));
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
      const detail = (await apiJson(page, `/api/m/cabs/${cabBySerial["DEMO-CAB-04"].id}`)).body;
      assert(detail.firmwareVersion === "1.0.0" && detail.changeLagMinutes === 30, "detail carries firmware and lag");
    });

    await check("home shows screens on, what plays and every cab", async () => {
      await goto(page, "/m");
      await page.getByTestId("cab-list").waitFor();
      const on = Number(await page.getByTestId("on-count").textContent());
      assert(on === overview.counts.online + overview.counts.updating, `on-count ${on}`);
      assert((await page.getByTestId("cab-row").count()) === overview.cabs.length, "one row per cab");
      assert((await page.getByTestId("fleet-loop").textContent()).includes(spring.name), "fleet plays Spring");
      await page.getByTestId("install-hint").waitFor();
      await shot(page, "home");
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
      await shot(page, "cab-gps-full", { fullPage: true });
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
      await page.getByTestId("cab-location-text").scrollIntoViewIfNeeded();
      await shot(page, "cab-cell-approximate");
      await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-07"].id}`);
      await page.getByTestId("cab-location-text").waitFor();
      assert((await page.getByTestId("cab-location-text").textContent()).includes("hasn’t reported"), "no position wording");
      await shot(page, "cab-never-seen", { fullPage: true });
      await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-04"].id}`);
      await page.getByTestId("cab-pending").waitFor();
      // DEMO-CAB-04 runs firmware 1.0.0, which only checks for changes every 30 minutes.
      assert((await page.getByTestId("cab-pending").textContent()).includes("within about 30 minutes"), "old-firmware cab: 30 minutes");
      await shot(page, "cab-switching");
      await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-06"].id}`);
      await page.getByTestId("resume-cab").waitFor();
      await shot(page, "cab-paused");
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
      // Demo positions drift with the clock, so another pin can sit on top of this one: send the
      // click to the marker itself rather than to whatever is drawn at its centre.
      await page.locator('[data-testid="map-marker"]', { hasText: "LX21 KCB" }).dispatchEvent("click");
      await page.getByTestId("map-card").waitFor();
      await shot(page, "map-selected-cab");
      await page.getByTestId("map-missing").click();
      await page.getByRole("dialog").waitFor();
      await shot(page, "map-missing-sheet");
      await page.keyboard.press("Escape");
    });

    // ---------------------------------------------------------------- change: all cabs
    await check("switch what all cabs play, confirm with real cab count, reflected and served", async () => {
      await tab(page, "Cabs").click();
      await page.waitForURL(/\/m$/);
      await page.getByTestId("change-fleet").click();
      await page.getByTestId("choose-video-list").waitFor();
      await shot(page, "change-choose-video");
      await page.locator(`[data-testid="choose-video"][data-loop-id="${theatre.id}"]`).click();
      await page.getByTestId("confirm-card").waitFor();
      const fresh = (await apiJson(page, "/api/m/overview")).body;
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
      // The done screen counts the server's answer (affectedCabs), not the phone's prediction.
      assert((await page.getByTestId("done-summary").textContent()).includes(`${following} cab`), "done count from the server");
      await shot(page, "change-done-fleet");
      const served = await manifestFor("DEMO-CAB-08"); // City group, follows all cabs
      assert(served.loopId === theatre.id, `DEMO-CAB-08 served ${served.loopId}`);
      // Cabs that are on pick it up on their next heartbeat.
      await npm("demo:heartbeat");
      await page.waitForFunction(() => /^[1-9]/.test(document.querySelector('[data-testid="done-progress"]')?.textContent ?? ""), null, { timeout: 40_000 });
      await shot(page, "change-done-fleet-progress", { fullPage: true });
      await page.getByTestId("done-home").click();
      await page.waitForURL(/\/m$/);
      await page.waitForFunction((name) => document.querySelector('[data-testid="fleet-loop"]')?.textContent?.includes(name), theatre.name);
      await shot(page, "home-after-fleet-change");
    });

    // ---------------------------------------------------------------- change: one cab, then back
    const cab08 = cabBySerial["DEMO-CAB-08"];
    await check("give one cab its own video, then return it to its group", async () => {
      await goto(page, `/m/cabs/${cab08.id}`);
      await page.getByTestId("change-cab").click();
      await page.locator(`[data-testid="choose-video"][data-loop-id="${portrait.id}"]`).click();
      await page.getByTestId("confirm-card").waitFor();
      assert((await page.getByTestId("impact-count").textContent()).includes("This changes 1 cab"), "one cab");
      assert((await page.getByTestId("confirm-question").textContent()).includes("LV20 MRK"), "names the cab");
      await shot(page, "change-confirm-cab", { fullPage: true });
      await page.getByTestId("confirm-change").click();
      await page.getByTestId("change-done").waitFor();
      assert((await manifestFor("DEMO-CAB-08")).loopId === portrait.id, "cab served its own video");
      await goto(page, `/m/cabs/${cab08.id}`);
      await page.getByTestId("cab-inherit").waitFor();
      await shot(page, "cab-own-video");
      await page.getByTestId("cab-inherit").click();
      await page.getByTestId("confirm-card").waitFor();
      assert((await page.getByTestId("confirm-question").textContent()).includes("back on"), "go-back wording");
      await shot(page, "change-confirm-cab-back", { fullPage: true });
      await page.getByTestId("confirm-change").click();
      await page.getByTestId("change-done").waitFor();
      assert((await manifestFor("DEMO-CAB-08")).loopId === theatre.id, "cab back on its group's (all cabs) video");
    });

    await check("group: use the same as all cabs", async () => {
      const westEnd = overview.groups.find((group) => group.name === "Demo · West End");
      await goto(page, "/m");
      await page.locator(`[data-testid="group-row"][data-group-id="${westEnd.id}"]`).click();
      await page.getByTestId("choose-inherit").waitFor();
      await shot(page, "change-group-choose");
      await page.getByTestId("choose-inherit").click();
      await page.getByTestId("confirm-card").waitFor();
      await shot(page, "change-confirm-group-follow-fleet", { fullPage: true });
      await page.getByTestId("confirm-change").click();
      await page.getByTestId("change-done").waitFor();
      assert((await manifestFor("DEMO-CAB-01")).loopId === theatre.id, "West End cab follows all cabs");
    });

    // ---------------------------------------------------------------- upload to a group
    const uploadName = `E2E upload ${RUN_ID}`;
    let uploadedId = null;
    await check("upload a real video from the phone to a group and wait until it is ready", async () => {
      const file = await makeVideo(path.join(workDir, "IMG_0042.MOV"));
      const city = overview.groups.find((group) => group.name === "Demo · City");
      await tab(page, "Upload").click();
      await page.waitForURL(/\/m\/upload/);
      await shot(page, "upload-empty");
      await page.getByTestId("upload-file").setInputFiles(file);
      await page.getByTestId("upload-name").fill(uploadName);
      await page.locator(".m-radio", { hasText: `${city.name} group` }).click();
      await page.waitForTimeout(800);
      await shot(page, "upload-form", { fullPage: true });
      await page.getByTestId("upload-submit").click();
      await page.getByTestId("upload-confirm").waitFor();
      await shot(page, "upload-confirm");
      await page.getByTestId("upload-confirm-go").click();
      await page.waitForFunction(() => ["uploading", "processing", "ready"].includes(document.querySelector('[data-testid="upload-job"]')?.getAttribute("data-phase") ?? ""));
      await shot(page, "upload-progress");
      // Leave the screen while the server works; the library shows it and the pill follows us.
      await tab(page, "Videos").click();
      await page.getByTestId("video-list").waitFor();
      await shot(page, "videos-while-uploading");
      await tab(page, "Upload").click();
      await page.locator('[data-testid="upload-job"][data-phase="ready"]').waitFor({ timeout: 180_000 });
      await shot(page, "upload-ready");
      const items = (await apiJson(page, "/api/m/loops")).body.items;
      const loop = items.find((item) => item.name === uploadName);
      assert(loop && loop.processing.state === "ready", "uploaded loop ready");
      uploadedId = loop.id;
      created.loops.add(loop.id);
      assert(loop.liveOn.groups.some((group) => group.id === city.id), "live on City group");
      assert((await manifestFor("DEMO-CAB-08")).loopId === loop.id, "City cab is served the upload");
      await page.getByTestId("upload-see").click();
      await page.getByTestId("video-title").waitFor();
      await shot(page, "video-detail-uploaded", { fullPage: true });
    });

    await check("a video that is playing can't be removed (explained)", async () => {
      await page.getByTestId("remove-video").click();
      await page.getByTestId("remove-sheet").waitFor();
      assert((await page.getByTestId("remove-sheet").textContent()).includes("Put a different video on those cabs first"), "explains why");
      await shot(page, "video-remove-blocked");
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
      await shot(page, "upload-failed-not-video");
      await page.getByTestId("upload-retry").click();
    });

    let brokenId = null;
    await check("failed upload during preparation shows the reason here and in Videos", async () => {
      // Looks like a QuickTime file (passes the quick check) but cannot be decoded.
      const header = Buffer.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0, 0x71, 0x74, 0x20, 0x20]);
      const broken = path.join(workDir, "broken.mov");
      writeFileSync(broken, Buffer.concat([header, Buffer.alloc(64 * 1024, 7)]));
      await page.getByTestId("upload-file").setInputFiles(broken);
      await page.getByTestId("upload-name").fill(`E2E broken ${RUN_ID}`);
      await page.getByTestId("upload-submit").click();
      await page.getByTestId("upload-failed-reason").waitFor({ timeout: 120_000 });
      const reason = await page.getByTestId("upload-failed-reason").textContent();
      assert(reason && reason.length > 10, `reason: ${reason}`);
      await shot(page, "upload-failed-processing");
      const items = (await apiJson(page, "/api/m/loops")).body.items;
      const loop = items.find((item) => item.name === `E2E broken ${RUN_ID}`);
      assert(loop && loop.processing.state === "failed", "failed loop listed");
      brokenId = loop.id;
      created.loops.add(loop.id);
      await page.getByTestId("upload-retry").click();
      await tab(page, "Videos").click();
      await page.locator(`[data-testid="video-row"][data-loop-id="${loop.id}"] [data-testid="video-failed-reason"]`).waitFor();
      await shot(page, "videos-with-failed");
    });

    await check("remove a video from the library", async () => {
      await page.locator(`[data-testid="video-row"][data-loop-id="${brokenId}"]`).click();
      await page.getByTestId("video-failed").waitFor();
      await shot(page, "video-detail-failed");
      await page.getByTestId("remove-video").click();
      await page.getByTestId("remove-confirm").click();
      await page.waitForURL(/\/m\/videos$/);
      await page.getByTestId("video-list").waitFor();
      await page.waitForTimeout(500);
      assert((await page.locator(`[data-testid="video-row"][data-loop-id="${brokenId}"]`).count()) === 0, "removed from list");
      await shot(page, "videos-after-remove");
    });

    // ---------------------------------------------------------------- queue + newer change wins (E, F)
    await check("uploads are prepared one at a time; an upload whose target changed meanwhile stays in Videos and says why", async () => {
      const city = overview.groups.find((group) => group.name === "Demo · City");
      const slow = await makeVideo(path.join(workDir, "slow.mov"), 60, "1920x1080");
      const quick = await makeVideo(path.join(workDir, "quick.mov"), 3);
      const { readFileSync } = await import("node:fs");
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
      const secondName = `E2E superseded ${RUN_ID}`;
      const secondId = await post(secondName, quick, { type: "group", groupId: city.id });
      const waiting = (await apiJson(page, `/api/m/loops/${secondId}`)).body;
      assert(waiting.processing.state === "processing" && waiting.processing.waiting === true, `second waits: ${JSON.stringify(waiting.processing)}`);
      await goto(page, `/m/videos/${secondId}`);
      await page.getByText("Waiting its turn").waitFor();
      await shot(page, "video-waiting-its-turn");
      // Someone changes what the City group plays while the upload is still being prepared.
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
      await goto(page, `/m/videos/${secondId}`);
      await page.getByText("Ready, but not put on screens").waitFor();
      await shot(page, "video-target-superseded", { fullPage: true });
    });

    // ---------------------------------------------------------------- pause / resume
    await check("pause and resume a cab's screen", async () => {
      const cab = cabBySerial["DEMO-CAB-01"];
      await goto(page, `/m/cabs/${cab.id}`);
      await page.getByTestId("pause-cab").click();
      await page.getByTestId("pause-sheet").waitFor();
      await page.locator('[data-testid="pause-sheet"] input').fill("E2E test");
      await shot(page, "pause-sheet");
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

    await check("all screens paused: a cab explains it and offers no resume that can't work", async () => {
      const paused = await apiJson(page, "/api/devices/disable-all", { method: "PUT", data: { reason: "E2E fleet pause" } });
      assert(paused.status === 200, `disable-all ${paused.status}`);
      try {
        const cab = cabBySerial["DEMO-CAB-01"];
        const api = (await apiJson(page, `/api/m/cabs/${cab.id}`)).body;
        assert(api.fleetPaused === true && api.cabPaused === false && api.isPaused === true, `pause fields ${JSON.stringify([api.fleetPaused, api.cabPaused])}`);
        await goto(page, `/m/cabs/${cab.id}`);
        await page.getByTestId("fleet-paused").waitFor();
        assert((await page.getByTestId("resume-cab").count()) === 0, "no per-cab resume during an all-screens pause");
        assert((await page.getByTestId("fleet-paused").textContent()).includes("can’t be resumed on its own"), "explains why");
        await page.getByTestId("fleet-paused").scrollIntoViewIfNeeded();
        await shot(page, "cab-fleet-paused");
        // A cab that is also paused on its own can still be resumed, and says the rest applies.
        await goto(page, `/m/cabs/${cabBySerial["DEMO-CAB-06"].id}`);
        await page.getByTestId("resume-cab").waitFor();
        await page.getByTestId("resume-cab").click();
        await page.getByTestId("pause-sheet").waitFor();
        assert((await page.getByTestId("pause-sheet").textContent()).includes("All screens are also paused"), "resume sheet mentions the all-screens pause");
        await page.keyboard.press("Escape");
      } finally {
        await apiJson(page, "/api/devices/enable-all", { method: "PUT", data: {} });
      }
    });

    // ---------------------------------------------------------------- freshness
    await check("network drop keeps the last data with a quiet notice", async () => {
      await goto(page, "/m");
      await page.getByTestId("cab-list").waitFor();
      await context.setOffline(true);
      await page.getByTestId("freshness").click();
      await page.getByTestId("offline-notice").waitFor();
      assert((await page.getByTestId("cab-row").count()) > 0, "still shows cabs");
      await shot(page, "home-offline");
      await context.setOffline(false);
      await page.getByTestId("freshness").click();
      await page.getByTestId("offline-notice").waitFor({ state: "detached" });
    });

    // ---------------------------------------------------------------- account & team
    await check("account, change password", async () => {
      await tab(page, "Account").click();
      await page.getByTestId("account-name").waitFor();
      await shot(page, "account");
      await page.getByTestId("account-password").click();
      await page.locator('input[name="current"]').waitFor();
      const temp = `Tmp-${RUN_ID}-pw`;
      await page.fill('input[name="current"]', PASSWORD);
      await page.fill('input[name="next"]', temp);
      await page.fill('input[name="repeat"]', temp);
      await page.getByRole("button", { name: "Change password" }).click();
      await page.getByTestId("password-done").waitFor();
      // Changing your own password signs you out elsewhere but keeps this phone signed in.
      assert((await apiJson(page, "/api/settings")).status === 200, "still signed in after own password change");
      await shot(page, "password-changed");
      // and back
      await page.fill('input[name="current"]', temp);
      await page.fill('input[name="next"]', PASSWORD);
      await page.fill('input[name="repeat"]', PASSWORD);
      await page.getByRole("button", { name: "Change password" }).click();
      await page.getByTestId("password-done").waitFor();
      await page.locator(".m-back").click();
    });

    const tester = { name: `E2E Tester ${RUN_ID}`, email: `e2e-${RUN_ID}@example.com` };
    await check("admin team screen: add, change role, reset password, remove", async () => {
      await page.getByTestId("account-team").click();
      await page.getByTestId("team-list").waitFor();
      await shot(page, "team");
      await page.getByTestId("team-add").click();
      await page.getByTestId("team-add-name").fill(tester.name);
      await page.getByTestId("team-add-email").fill(tester.email);
      await page.getByTestId("team-add-password").fill("Welcome-123");
      await shot(page, "team-add");
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
      await shot(page, "team-edit");
      await page.keyboard.press("Escape");
      assert((await row.textContent()).includes("Admin"), "role changed to admin");
      await row.click();
      await page.getByTestId("team-remove").click();
      await shot(page, "team-remove-confirm");
      await page.getByTestId("team-remove-confirm").click();
      await row.waitFor({ state: "detached" });
      created.users.delete(tester.email);
    });

    await check("a reset or removed teammate's session stops working on every route", async () => {
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
        const cab = cabBySerial["DEMO-CAB-03"];
        assert((await status("/api/settings")) === 200 && (await status("/api/m/overview")) === 200, "teammate signed in");
        // Admin resets their password (e.g. the phone was lost).
        const reset = await apiJson(page, `/api/users/${made.body.id}`, { method: "PATCH", data: { password: "Another-456" } });
        assert(reset.status === 200, `reset ${reset.status}`);
        assert((await status("/api/settings")) === 401, "old session refused on settings");
        assert((await status("/api/loops")) === 401, "old session refused on loops");
        assert((await status(`/api/devices/${cab.id}/disable`, { method: "POST", data: { reason: "should not work" } })) === 401, "old session cannot pause a cab");
        assert((await status("/api/m/overview")) === 401, "old session refused on the phone API");
        assert((await apiJson(page, `/api/m/cabs/${cab.id}`)).body.cabPaused === false, "cab was not paused");
        await mp.goto(`${BASE}/m`, { waitUntil: "domcontentloaded" });
        await mp.waitForURL(/\/m\/login/);
        // Signing in again works; then the admin removes them.
        await signIn("Another-456");
        assert((await status("/api/loops")) === 200, "new session works");
        const removed = await apiJson(page, `/api/users/${made.body.id}`, { method: "DELETE" });
        assert(removed.status === 200, `delete ${removed.status}`);
        created.users.delete(mate.email);
        assert((await status("/api/loops")) === 401 && (await status(`/api/devices/${cab.id}`)) === 401, "removed user refused");
      } finally {
        await other.close();
      }
    });

    // ---------------------------------------------------------------- 401 and sign out
    await check("a 401 from the API sends the user to sign in", async () => {
      await goto(page, "/m/videos");
      await page.getByTestId("video-list").waitFor();
      const cookies = await context.cookies();
      await context.clearCookies();
      await page.getByTestId("freshness").click();
      await page.waitForURL(/\/m\/login\?next=%2Fm%2Fvideos/);
      await context.addCookies(cookies);
    });

    await check("sign out", async () => {
      await goto(page, "/m/account");
      await page.waitForFunction(() => (document.querySelector('[data-testid="account-name"]')?.textContent ?? "").trim().length > 1);
      await page.getByTestId("sign-out").click();
      await page.waitForURL(/\/m\/login/, { waitUntil: "domcontentloaded" });
      await goto(page, "/m");
      await page.waitForURL(/\/m\/login\?next=%2Fm/);
      await context.close();
    });

    // ---------------------------------------------------------------- entry points
    await check("phone at the site root gets the mobile app; desktop keeps the desktop app", async () => {
      const phone = await newPhoneContext(browser);
      const phonePage = await phone.newPage();
      await phonePage.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await phonePage.waitForURL(/\/m\/login\?next=%2Fm$/);
      await phonePage.goto(`${BASE}/?view=desktop`, { waitUntil: "domcontentloaded" });
      await phonePage.waitForURL(/\/login\?next=%2F$/);
      assert(!phonePage.url().includes("/m/"), "explicit desktop link works on a phone");
      await phone.close();

      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await desktop.route((url) => url.hostname !== new URL(BASE).hostname, (route) => route.abort());
      const desk = await desktop.newPage();
      await desk.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await desk.waitForURL(/\/login/);
      await shot(desk, "desktop-login");
      await desk.fill('input[name="email"]', EMAIL);
      await desk.fill('input[name="password"]', PASSWORD);
      await desk.click('button[type="submit"]');
      await desk.waitForURL(`${BASE}/`, { waitUntil: "domcontentloaded" });
      for (const route of ["/", "/devices", "/loops"]) {
        await desk.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
        await desk.locator(".sidebar").waitFor();
        await desk.waitForTimeout(1200);
        assert(!(await desk.locator("text=Application error").count()), `${route} renders`);
        await shot(desk, `desktop${route === "/" ? "-dashboard" : route.replace("/", "-")}`);
      }
      await desktop.close();
    });

    // ---------------------------------------------------------------- small phone
    await check("small phone (375x667) screens", async () => {
      const small = await newPhoneContext(browser, devices["iPhone SE"], { viewport: { width: 375, height: 667 } });
      const sp = await small.newPage();
      await sp.goto(`${BASE}/m/login`, { waitUntil: "domcontentloaded" });
      await shot(sp, "small-login");
      await login(sp, { expectNext: "/m" });
      await sp.getByTestId("cab-list").waitFor();
      await shot(sp, "small-home");
      await sp.goto(`${BASE}/m/cabs/${cabBySerial["DEMO-CAB-03"].id}`, { waitUntil: "domcontentloaded" });
      await sp.getByTestId("cab-head").waitFor();
      await shot(sp, "small-cab");
      await sp.goto(`${BASE}/m/change?target=fleet&loop=${spring.id}`, { waitUntil: "domcontentloaded" });
      await sp.getByTestId("confirm-card").waitFor();
      await shot(sp, "small-change-confirm");
      await sp.goto(`${BASE}/m/upload`, { waitUntil: "domcontentloaded" });
      await sp.getByTestId("upload-submit").waitFor();
      await shot(sp, "small-upload");
      await sp.goto(`${BASE}/m/map`, { waitUntil: "domcontentloaded" });
      await sp.locator('[data-testid="map-marker"]').first().waitFor();
      await shot(sp, "small-map");
      await sp.goto(`${BASE}/m/videos`, { waitUntil: "domcontentloaded" });
      await sp.getByTestId("video-list").waitFor();
      await shot(sp, "small-videos");
      // the bottom of a scrolled screen stays clear of the tab bar
      const overlap = await sp.evaluate(() => {
        const bar = document.querySelector(".m-tabbar").getBoundingClientRect();
        return document.documentElement.scrollWidth > window.innerWidth || bar.height > 120;
      });
      assert(!overlap, "no horizontal scroll, tab bar sane");
      await small.close();
    });

    // ---------------------------------------------------------------- PWA bits
    await check("installable: manifest, icons and iOS meta", async () => {
      const response = await fetch(`${BASE}/m-app/manifest.webmanifest`);
      const manifest = await response.json();
      assert(manifest.start_url === "/m" && manifest.display === "standalone", "manifest start_url/display");
      for (const icon of [...manifest.icons.map((i) => i.src), "/m-app/apple-touch-icon.png"]) {
        const res = await fetch(`${BASE}${icon}`);
        assert(res.ok && res.headers.get("content-type").includes("png"), `${icon} is a PNG`);
      }
      const html = await (await fetch(`${BASE}/m/login`)).text();
      for (const needle of ['rel="manifest"', 'apple-touch-icon', 'apple-mobile-web-app-capable', 'black-translucent', 'viewport-fit=cover', 'name="theme-color"']) {
        assert(html.includes(needle), `head has ${needle}`);
      }
      void uploadedId;
    });
  } finally {
    await browser.close().catch(() => undefined);
    await cleanup();
  }
}

async function cleanup() {
  console.log("- restoring demo data ...");
  try {
    await npm("demo:seed");
    // Clear the cab override this run may have left and archive the videos it uploaded.
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const headers = { cookie, "Content-Type": "application/json" };
    const loops = await (await fetch(`${BASE}/api/m/loops`, { headers })).json();
    for (const loop of loops.items ?? []) {
      if (loop.name.includes(RUN_ID) || created.loops.has(loop.id)) {
        await fetch(`${BASE}/api/m/loops/${loop.id}/archive`, { method: "POST", headers });
      }
    }
    const users = await (await fetch(`${BASE}/api/users`, { headers })).json();
    for (const user of users.items ?? []) {
      if (user.email.startsWith("e2e-")) await fetch(`${BASE}/api/users/${user.id}`, { method: "DELETE", headers });
    }
    await npm("demo:heartbeat");
    console.log("  done");
  } catch (error) {
    console.log(`  cleanup problem: ${error.message}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${SHOTS}`);
    process.exit(failed.length ? 1 : 0);
  })
  .catch((error) => {
    console.log(`\nE2E FAILED: ${error.message}`);
    process.exit(1);
  });
