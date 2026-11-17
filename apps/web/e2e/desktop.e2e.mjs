// End-to-end test of the desktop loop workflow against a running dev server, as staff use it.
//
//   node apps/web/e2e/desktop.e2e.mjs
//
// Env: BASE_URL (default http://localhost:3000), SHOTS_DIR (screenshots at deviceScaleFactor 2;
//      default apps/web/e2e/shots-desktop), E2E_EMAIL / E2E_PASSWORD (default: the seeded admin),
//      MEDIA_DIR (test media; default: generated with ffmpeg into a temp folder), DATABASE_URL
//      (only to remove the test cab at the end: there is no API to delete a cab).
// Needs ffmpeg, psql and Playwright with Chromium. External hosts are blocked.
//
// It never reseeds or changes existing data: everything it creates is named with a unique prefix
// (E2E-LOOPS-<time>), its loop plays only on a test group with one test cab, and it removes all
// of it at the end (also after a failure). It checks the demo cabs are told exactly the same thing
// before and after.
//
// Covers: asset upload (a 10-bit HEVC HDR clip and a silent clip among them) and processing; the
// builder with adverts of different lengths, the slot arithmetic and the cut/held warnings;
// saving; the unsaved-changes guard (link and Back button); duplicate; publish with live
// progress; where the loop is live; changing its target with the confirmation; taking it off air
// and seeing what plays instead; removing an asset that is in use; deleting the loop and checking
// its stored objects are gone; and that the routing surprises R1-R3 no longer happen.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS_DIR ?? path.join(here, "shots-desktop");
const EMAIL = process.env.E2E_EMAIL ?? "admin@orisonscreens.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "ChangeMe123!";
const PREFIX = `E2E-LOOPS-${Date.now().toString(36).toUpperCase()}`;
mkdirSync(SHOTS, { recursive: true });

const created = { assets: [], loops: [], groups: [], cabs: [] };
let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${message}`);
  }
}
const step = (title) => console.log(`\n${title}`);

// --- test media -------------------------------------------------------------------------------
async function makeMedia() {
  if (process.env.MEDIA_DIR) return process.env.MEDIA_DIR;
  const dir = mkdtempSync(path.join(os.tmpdir(), "orison-e2e-media-"));
  const ff = (args) => run("ffmpeg", ["-v", "error", "-y", ...args]);
  await ff(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", path.join(dir, "advert-30s.mp4")]);
  await ff(["-f", "lavfi", "-i", "smptebars=s=1280x720:r=25", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "advert-10s.mp4")]);
  // iPhone default: 10-bit HEVC with HLG, in a .mov
  await ff(["-f", "lavfi", "-i", "testsrc=s=1920x1080:r=30", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "12", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1", "-c:a", "aac", path.join(dir, "filler-iphone-hevc10-hlg.mov")]);
  // silent, and shorter than the time it will be given
  await ff(["-f", "lavfi", "-i", "rgbtestsrc=s=1280x800:r=30", "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path.join(dir, "filler-silent-4s.mp4")]);
  await ff(["-f", "lavfi", "-i", "color=c=0x1f6f8b:s=1600x1200", "-frames:v", "1", path.join(dir, "still-1600x1200.png")]);
  return dir;
}

// --- API helpers (same session as the browser) -----------------------------------------------
let api;
async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}
async function cabAnswer(serial) {
  const response = await api.get(`${BASE}/api/devices/manifest`, { headers: { Authorization: "Bearer local-device-token", "X-Device-Serial": serial } });
  if (response.status() !== 200) return { status: response.status() };
  const body = await response.json();
  return { loopId: body.loopId, manifestUrl: body.manifestUrl, version: body.version, checksum: body.checksum, compiledVideoUrl: body.compiledVideoUrl };
}
const DEMO = Array.from({ length: 8 }, (_, index) => `DEMO-CAB-0${index + 1}`);
async function demoAnswers() {
  return Object.fromEntries(await Promise.all(DEMO.map(async (serial) => [serial, await cabAnswer(serial)])));
}

async function main() {
  const media = await makeMedia();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  api = context.request;
  let shotIndex = 0;
  const shot = async (name, options = {}) => {
    shotIndex += 1;
    const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: file, fullPage: options.fullPage ?? true });
    console.log(`  shot ${path.basename(file)}`);
  };
  const toast = async (text) => {
    const locator = page.locator(".toast", { hasText: text }).first();
    await locator.waitFor({ timeout: 20_000 });
    return locator;
  };

  try {
    step("Sign in");
    await page.goto(`${BASE}/login?next=/loops`);
    await shot("login");
    await page.fill("input[name=email]", EMAIL);
    await page.fill("input[name=password]", PASSWORD);
    await Promise.all([page.waitForURL(/\/loops$/), page.click("button[type=submit]")]);
    check(page.url().endsWith("/loops"), "sign-in returns to the page that asked for it");
    const demoBefore = await demoAnswers();

    step("Test group and cab (named with the prefix)");
    for (const suffix of ["A", "B"]) {
      let response = await api.post(`${BASE}/api/device-groups`, { data: { name: `${PREFIX} group ${suffix}` } });
      for (let attempt = 0; attempt < 3 && !response.ok(); attempt += 1) {
        // The dev server can fail a request while it compiles a route on first use.
        console.log(`  (group request answered ${response.status()}; retrying)`);
        await page.waitForTimeout(3000);
        response = await api.post(`${BASE}/api/device-groups`, { data: { name: `${PREFIX} group ${suffix}` } });
      }
      const group = await json(response);
      check(response.ok(), `created group ${suffix}`);
      created.groups.push(group.id);
    }
    const cabResponse = await api.post(`${BASE}/api/devices`, { data: { serialNumber: `${PREFIX}-CAB`, cabLicenseNumber: `${PREFIX} CAB` } });
    const cab = await json(cabResponse);
    created.cabs.push(cab.id);
    await api.put(`${BASE}/api/devices/${cab.id}`, { data: { groupId: created.groups[0] } });
    const cabSerial = `${PREFIX}-CAB`;
    const cabBefore = await cabAnswer(cabSerial);

    step("Upload assets on the Assets page");
    const uploads = [
      ["advert-30s.mp4", "ADVERTISEMENT"],
      ["advert-10s.mp4", "ADVERTISEMENT"],
      ["filler-iphone-hevc10-hlg.mov", "FILLER_BRANDED"],
      ["filler-silent-4s.mp4", "FILLER_OTHER"],
      ["still-1600x1200.png", "STATIC_CREATIVE"],
    ];
    // Warm up the routes used below (the dev server compiles on first use and its Fast Refresh
    // can reload the page in the middle of an upload).
    await api.get(`${BASE}/api/assets?search=${PREFIX}`);
    await api.get(`${BASE}/api/assets/none`);
    await page.goto(`${BASE}/assets`);
    await page.waitForTimeout(3000);
    for (const [file, category] of uploads) {
      const named = path.join(media, file);
      const prefixed = path.join(mkdtempSync(path.join(os.tmpdir(), "orison-e2e-up-")), `${PREFIX}-${file}`);
      await run("cp", [named, prefixed]);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await page.setInputFiles("input[type=file]", prefixed);
        if (await page.locator(".drop-zone strong", { hasText: `${PREFIX}-${file}` }).isVisible().catch(() => false)) break;
        console.log("  (file not taken yet:", await page.locator(".drop-zone strong").innerText(), ")");
        await page.waitForTimeout(500);
      }
      await page.selectOption(".asset-upload-grid select", category);
      await page.fill("input[placeholder^='Nike']", `${PREFIX} advertiser`);
      let response = null;
      for (let attempt = 0; attempt < 2 && !response; attempt += 1) {
        [response] = await Promise.all([
          page.waitForResponse((r) => r.url().includes("/api/assets/upload") && r.request().method() === "POST", { timeout: 30_000 }).catch(() => null),
          page.click("button[type=submit]:has-text('Upload')"),
        ]);
        if (!response) {
          console.log("  (upload did not start: page reloaded by the dev server; trying again)");
          await page.reload();
          await page.setInputFiles("input[type=file]", prefixed);
          await page.selectOption(".asset-upload-grid select", category);
        }
      }
      const list = await json(await api.get(`${BASE}/api/assets?search=${encodeURIComponent(`${PREFIX}-${file}`)}`));
      const asset = list.items?.[0] ?? {};
      check(response.status() === 201 && asset.id, `${file}: accepted at once (${response.status()}), processed in the background`);
      created.assets.push(asset.id);
      if (file.startsWith("filler-iphone")) await shot("assets-uploading");
      // One at a time, as staff do: wait until this one is processed, then start from a fresh page.
      for (let wait = 0; wait < 120; wait += 1) {
        const current = await json(await api.get(`${BASE}/api/assets/${asset.id}`));
        if (current.status !== "PROCESSING") break;
        await page.waitForTimeout(2000);
      }
      await page.goto(`${BASE}/assets`);
      await page.waitForTimeout(1500);
    }
    await page.fill("input[placeholder^='Search']", PREFIX);
    await page.click("button:has-text('Search')");
    const deadline = Date.now() + 240_000;
    let assets = [];
    while (Date.now() < deadline) {
      assets = await Promise.all(created.assets.map(async (id) => json(await api.get(`${BASE}/api/assets/${id}`))));
      if (assets.every((asset) => asset.status !== "PROCESSING")) break;
      await page.waitForTimeout(2000);
    }
    for (const asset of assets) check(asset.status === "READY", `${asset.filename}: ${asset.status} ${asset.errorMessage ?? ""} (${asset.durationMs ?? "still"} ms, ${asset.width}x${asset.height})`);
    const hevc = assets.find((asset) => asset.filename.includes("hevc10"));
    check(hevc?.width === 1920 && hevc?.height === 1080, "10-bit HEVC HDR clip kept at its own size (1920x1080), not shrunk to the screen");
    await page.reload();
    await page.waitForSelector(".asset-card");
    await shot("assets-library");
    const [advert30, advert10, fillerHevc, fillerSilent, still] = created.assets;

    step("Create a loop and build it in the builder");
    await page.goto(`${BASE}/loops`);
    await shot("loops-list");
    await page.fill("input[aria-label='Name of the new loop']", `${PREFIX} rotation`);
    await Promise.all([page.waitForURL(/\/loops\/[a-z0-9]+$/), page.click("button:has-text('Create loop')")]);
    const loopId = page.url().split("/").pop();
    created.loops.push(loopId);
    await page.waitForSelector(".lb-slot");
    await shot("builder-empty");

    // Target the test group (not on air yet: no confirmation needed).
    await page.selectOption("select[aria-label='Plays on']", created.groups[0]);
    await toast("Target changed");

    async function pick(name) {
      await page.fill(".lb-search", PREFIX);
      await page.locator(".lb-pick", { hasText: name }).first().click();
    }
    async function addFiller(name) {
      await page.click("button:has-text('Add filler')");
      await pick(name);
    }

    // Slot 1: a 30 s advert, the 4 s silent filler (shorter than its time), then the HEVC filler.
    await page.locator(".lb-slot").nth(0).click();
    await page.click("button:has-text('Choose advert')");
    await pick("advert-30s");
    const sum1 = await page.locator(".lb-sum-text").innerText();
    check(/advert 30 s = 30 s, 30 s short of 60 s/.test(sum1), `arithmetic after choosing the 30 s advert: "${sum1}"`);
    await addFiller("filler-silent-4s");
    await addFiller("hevc10");
    const sum2 = await page.locator(".lb-sum-text").innerText();
    check(/advert 30 s \+ fillers 4 s \+ 12 s = 46 s, 14 s short/.test(sum2), `arithmetic with two fillers: "${sum2}"`);
    // Give the silent clip 18 s: it will be held on its last frame for 14 s.
    const silentInput = page.locator(".lb-item", { hasText: "filler-silent-4s" }).locator("input");
    await silentInput.fill("");
    await silentInput.press("Enter");
    check((await silentInput.inputValue()) === "4.0", "clearing a duration field changes nothing (it does not become 1)");
    await silentInput.fill("18");
    await silentInput.press("Enter");
    const sum3 = await page.locator(".lb-sum-text").innerText();
    check(/= 60 s, exactly 60 s/.test(sum3), `slot adds up: "${sum3}"`);
    const warning = await page.locator(".lb-item", { hasText: "filler-silent-4s" }).locator(".lb-fit").innerText();
    check(/last frame will be held, silent, for 14 s/.test(warning), `held warning: "${warning}"`);
    await page.click("button:has-text('Choose still image')");
    await pick("still-1600x1200");
    await shot("builder-slot-1");

    // Slot 2: the 10 s advert, filled from the filler template (the template dialog explains the
    // adjustment), or by hand when this database's template does not fit.
    await page.locator(".lb-slot").nth(1).click();
    await page.click("button:has-text('Choose advert')");
    await pick("advert-10s");
    await page.click("button:has-text('Fill from template')");
    await page.waitForSelector(".lb-template");
    await shot("builder-template-dialog", { fullPage: false });
    // Use the template only if it fits and every row can take one of this run's fillers (the
    // template in Settings belongs to the team and is not changed here).
    let templateFits = await page.locator(".lb-template button:has-text('Replace this slot')").isEnabled();
    for (const select of await page.locator(".lb-template select").all()) {
      if ((await select.locator("option", { hasText: PREFIX }).count()) === 0) templateFits = false;
    }
    console.log(`  (template ${templateFits ? "used" : "does not fit this run's files: fillers added by hand"})`);
    if (templateFits) {
      for (const select of await page.locator(".lb-template select").all()) {
        const value = await select.locator("option", { hasText: PREFIX }).first().getAttribute("value");
        if (value) await select.selectOption(value);
      }
      await page.click(".lb-template button:has-text('Replace this slot')");
    } else {
      await page.click(".lb-template button:has-text('Cancel')");
      await addFiller("hevc10");
      await addFiller("filler-silent-4s");
      await page.click("button:has-text('Give the last filler')");
    }
    const sum4 = await page.locator(".lb-sum-text").innerText();
    check(/^advert 10 s .*= 60 s, exactly 60 s/.test(sum4), `slot 2 with a 10 s advert adds up: "${sum4}"`);

    // Slots 3-10: alternate the two adverts, then the HEVC filler (12 s) and the silent clip for
    // the rest of the minute (held on its last frame).
    for (let position = 2; position < 10; position += 1) {
      await page.locator(".lb-slot").nth(position).click();
      await page.click("button:has-text('Choose advert')");
      await pick(position % 2 === 0 ? "advert-30s" : "advert-10s");
      await addFiller("hevc10");
      await addFiller("filler-silent-4s");
      await page.click("button:has-text('Give the last filler')");
    }
    // One advert shortened by staff: slot 3's 30 s advert to 20 s (cut off), then fill.
    await page.locator(".lb-slot").nth(2).click();
    const advertInput = page.locator(".lb-item.is-ad input");
    await advertInput.fill("20");
    await advertInput.press("Enter");
    check(/last 10 s will be cut off/.test(await page.locator(".lb-item.is-ad .lb-fit").innerText()), "shortened advert says what will be cut off");
    await page.click("button:has-text('Give the last filler')");
    await shot("builder-ready-unsaved");
    check((await page.locator(".lb-slot-status.is-bad").count()) === 0, "all ten slots ready");

    step("Unsaved-changes guard");
    let dialogs = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.click("a.lb-back");
    await page.waitForTimeout(500);
    check(page.url().endsWith(`/loops/${loopId}`) && dialogs.some((message) => /unsaved changes/.test(message)), "clicking a link with unsaved slots asks first and stays when cancelled");
    dialogs = [];
    await page.goBack();
    await page.waitForTimeout(800);
    check(page.url().endsWith(`/loops/${loopId}`) && dialogs.length > 0, "the Back button asks first and stays when cancelled");
    page.removeAllListeners("dialog");

    step("Save, with field-level errors and stale-save protection");
    await page.click("button:has-text('Save changes')");
    await toast("Saved");
    const shortName = await api.put(`${BASE}/api/loops/${loopId}`, { data: { name: "x" } });
    const shortNameBody = await json(shortName);
    check(shortName.status() === 400 && /Name must be at least 2 characters/.test(shortNameBody.error), `a one-character name says which field is wrong: "${shortNameBody.error}"`);
    const stale = await api.put(`${BASE}/api/loops/${loopId}/slots`, {
      data: { slots: [{ position: 0, contents: [], expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }] },
    });
    check(stale.status() === 409, `a slot save based on old data is refused (${stale.status()}): "${(await json(stale)).error}"`);

    step("R3: a loop's status cannot be set directly");
    const r3 = await api.put(`${BASE}/api/loops/${loopId}`, { data: { status: "PUBLISHED" } });
    check(r3.status() === 400, `PUT status PUBLISHED refused (${r3.status()}): "${(await json(r3)).error}"`);
    const r3state = await json(await api.get(`${BASE}/api/loops/${loopId}/publish`));
    check(r3state.state.status === "DRAFT", "the loop is still a draft");

    step("Duplicate");
    await page.click("button:has-text('Duplicate')");
    await page.waitForURL((url) => !url.pathname.endsWith(loopId));
    const copyId = page.url().split("/").pop();
    created.loops.push(copyId);
    const copyName = await page.locator("input[aria-label='Loop name']").inputValue();
    check(copyName === `${PREFIX} rotation (copy)`, `copy opened as "${copyName}"`);
    check((await page.locator(".lb-slot-status.is-bad").count()) === 0, "the copy has all ten slots");
    await shot("builder-duplicate");
    await page.goto(`${BASE}/loops/${loopId}`);

    step("Publish and watch progress");
    await page.waitForSelector(".lb-slot");
    await page.click("button:has-text('Publish')");
    await page.waitForSelector(".lx-confirm");
    await shot("publish-confirm", { fullPage: false });
    const started = Date.now();
    await page.click(".lx-confirm button:has-text('Publish')");
    await page.waitForSelector(".lx-progress");
    check(Date.now() - started < 10_000, "publish returns at once and shows progress");
    let progressShot = false;
    while (Date.now() - started < 15 * 60_000) {
      if ((await page.locator(".lx-progress strong").count()) === 0) break;
      const label = await page.locator(".lx-progress strong").innerText({ timeout: 2000 }).catch(() => "");
      if (!progressShot && /Encoding/.test(label)) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await shot("publish-progress", { fullPage: false });
        progressShot = true;
      }
      await page.waitForTimeout(1000);
    }
    await toast("Published");
    const published = await json(await api.get(`${BASE}/api/loops/${loopId}/publish`));
    check(published.state.status === "PUBLISHED" && !published.state.publishError, `published in ${Math.round((Date.now() - started) / 1000)} s`);
    check(published.state.live && /group .*group A/.test(published.state.liveLabel), `live on: ${published.state.liveLabel}`);
    const cabAfterPublish = await cabAnswer(cabSerial);
    check(cabAfterPublish.loopId === loopId, "the test cab is told to play it");
    await page.reload();
    await page.waitForSelector(".lb-slot");
    await shot("builder-published");
    await page.goto(`${BASE}/loops`);
    await page.waitForSelector(".ll-table");
    await shot("loops-list-live");
    const row = page.locator("tr", { hasText: `${PREFIX} rotation` }).first();
    check(/On air/.test(await row.innerText()) && /group A/.test(await row.innerText()), "the list shows where it is live");

    step("Republish unchanged: nothing new for the cab");
    const before = await cabAnswer(cabSerial);
    await api.post(`${BASE}/api/loops/${loopId}/publish`);
    for (let index = 0; index < 30; index += 1) {
      const state = await json(await api.get(`${BASE}/api/loops/${loopId}/publish`));
      if (state.state.publish.kind !== "running") break;
      await page.waitForTimeout(500);
    }
    check(JSON.stringify(await cabAnswer(cabSerial)) === JSON.stringify(before), "the cab is told exactly the same thing");

    step("R1: changing the target of a live loop is confirmed, logged, and says what changes");
    await page.goto(`${BASE}/loops/${loopId}`);
    await page.waitForSelector(".lb-slot");
    await page.selectOption("select[aria-label='Plays on']", created.groups[1]);
    await page.waitForSelector(".lx-confirm");
    const targetLines = await page.locator(".lx-effect-list").innerText();
    check(/1 cab .*→ "Demo|1 cab .*→ /.test(targetLines) || /Group/.test(targetLines), `the confirmation lists the change: ${targetLines.replace(/\n/g, " | ")}`);
    await shot("target-change-confirm", { fullPage: false });
    await page.click(".lx-confirm button:has-text('Cancel')");
    check((await cabAnswer(cabSerial)).loopId === loopId, "cancelled: the cab still plays the loop");
    const plainPut = await api.put(`${BASE}/api/loops/${loopId}`, { data: { targetGroupId: created.groups[1] } });
    check(plainPut.status() === 409, `a plain save of the target of a live loop is refused (${plainPut.status()})`);
    await page.reload();
    await page.waitForSelector(".lb-slot");
    await page.selectOption("select[aria-label='Plays on']", created.groups[1]);
    await page.click(".lx-confirm button:has-text('Move it now')");
    await toast("Target changed");
    const moved = await json(await api.get(`${BASE}/api/loops/${loopId}/publish`));
    check(/group B/.test(moved.state.liveLabel), `now live on ${moved.state.liveLabel}`);
    check((await cabAnswer(cabSerial)).loopId !== loopId, "the cab in group A no longer plays it");
    const groupDelete = await api.delete(`${BASE}/api/device-groups/${created.groups[1]}`);
    check(groupDelete.status() === 409, `deleting a group a live loop plays on is refused, never making it play on all cabs (${groupDelete.status()}): "${(await json(groupDelete)).error}"`);
    // Move it back for the rest of the run.
    await api.post(`${BASE}/api/loops/${loopId}/target`, { data: { targetGroupId: created.groups[0] } }).then(json).then((body) =>
      api.post(`${BASE}/api/loops/${loopId}/target`, { data: { targetGroupId: created.groups[0], token: body.token } }),
    );

    step("Edit after publishing: 'changes not yet published'");
    await page.reload();
    await page.waitForSelector(".lb-slot");
    await page.locator(".lb-slot").nth(9).click();
    await page.locator(".lb-item", { hasText: "hevc10" }).locator("button:has-text('Remove')").click();
    await page.click("button:has-text('Give the last filler')");
    await page.click("button:has-text('Save changes')");
    await toast("Saved");
    await page.reload();
    await page.waitForSelector(".lb-slot");
    check(await page.locator(".lx-badge-warn", { hasText: "Changes not yet published" }).isVisible(), "the builder says the saved changes are not on air yet");

    step("R2: Pause says what will play instead");
    await page.click("button:has-text('Pause')");
    await page.waitForSelector(".lx-confirm");
    const pauseLines = await page.locator(".lx-effect-list").innerText();
    check(/→/.test(pauseLines), `what plays instead: ${pauseLines.replace(/\n/g, " | ")}`);
    await shot("pause-confirm", { fullPage: false });
    await page.click(".lx-confirm button:has-text('Pause it')");
    await toast("Paused");
    check(JSON.stringify(await cabAnswer(cabSerial)) === JSON.stringify(cabBefore), "the cab is back to what it played before the test");

    step("Remove an asset that is in use");
    await page.goto(`${BASE}/assets?search=${encodeURIComponent(PREFIX)}`);
    await page.locator(".asset-card", { hasText: "advert-30s" }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.click("button:has-text('Remove from library')");
    const removed = await toast("Removed from the library");
    check(/kept because/.test(await removed.innerText()), `in-use asset hidden, file kept: "${(await removed.innerText()).replace(/\n/g, " ")}"`);
    await shot("asset-removed");

    step("Delete the loop: its stored objects are gone");
    const loopRow = await json(await api.get(`${BASE}/api/loops/${loopId}`));
    const keys = [loopRow.compiledVideoKey, loopRow.posterKey, loopRow.manifestKey].filter(Boolean);
    for (const key of keys) check((await api.get(`${BASE}/api/storage/${key}`, { maxRedirects: 0 })).status() < 400, `before: ${key} exists`);
    await page.goto(`${BASE}/loops/${loopId}`);
    await page.waitForSelector(".lb-slot");
    await page.click("button:has-text('Delete')");
    await page.click(".lx-confirm button:has-text('Delete loop')");
    await page.waitForURL(/\/loops$/);
    created.loops = created.loops.filter((id) => id !== loopId);
    // (A missing manifest currently answers 500 rather than 404 from the storage route.)
    for (const key of keys) check((await api.get(`${BASE}/api/storage/${key}`, { maxRedirects: 0 })).status() >= 400, `after: ${key} is gone`);
    const hiddenAsset = await api.get(`${BASE}/api/assets/${advert30}`);
    check(hiddenAsset.status() === 200, "the hidden advert is kept while the copy still uses it");

    step("Routing: the demo cabs were never touched");
    check(JSON.stringify(await demoAnswers()) === JSON.stringify(demoBefore), "all eight demo cabs are told exactly what they were told before");
    void advert10; void fillerHevc; void fillerSilent; void still;
  } catch (error) {
    failures += 1;
    console.error(error);
    await page.screenshot({ path: path.join(SHOTS, "failure.png"), fullPage: true }).catch(() => undefined);
  } finally {
    await cleanup();
    await browser.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

async function cleanup() {
  step("Clean up");
  for (const loopId of created.loops) {
    const state = await json(await api.get(`${BASE}/api/loops/${loopId}/publish`)).catch(() => null);
    if (state?.state?.status === "PUBLISHED") {
      const first = await json(await api.post(`${BASE}/api/loops/${loopId}/pause`, { data: {} }));
      if (first.token) await api.post(`${BASE}/api/loops/${loopId}/pause`, { data: { token: first.token } });
    }
    const response = await api.delete(`${BASE}/api/loops/${loopId}`);
    console.log(`  loop ${loopId}: ${response.status()}`);
  }
  for (const assetId of created.assets) {
    const response = await api.delete(`${BASE}/api/assets/${assetId}`);
    const body = await json(response);
    console.log(`  asset ${assetId}: ${response.status()} ${body.outcome ?? body.error ?? ""}`);
  }
  if (created.cabs.length && process.env.DATABASE_URL) {
    const ids = created.cabs.map((id) => `'${id}'`).join(",");
    await run("psql", [process.env.DATABASE_URL, "-c", `DELETE FROM "Device" WHERE id IN (${ids})`]).catch((error) => console.log("  could not delete the test cab:", error.message));
    console.log(`  cab(s) deleted: ${created.cabs.join(", ")}`);
  } else if (created.cabs.length) {
    for (const id of created.cabs) await api.put(`${BASE}/api/devices/${id}`, { data: { groupId: null, isActive: false } });
    console.log("  DATABASE_URL not set: the test cab was made inactive instead of deleted");
  }
  for (const groupId of created.groups) {
    const response = await api.delete(`${BASE}/api/device-groups/${groupId}`);
    console.log(`  group ${groupId}: ${response.status()}`);
  }
}

await main();
