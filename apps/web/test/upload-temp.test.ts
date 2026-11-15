import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { removeStaleUploadTempDirs } from "../src/lib/upload-temp";

const root = mkdtempSync(path.join(os.tmpdir(), "orison-temp-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function makeDir(name: string, ageMs: number) {
  const dir = path.join(root, name);
  mkdirSync(dir);
  const file = path.join(dir, "upload.mov");
  writeFileSync(file, "x");
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
  utimesSync(dir, when, when);
  return dir;
}

describe("removeStaleUploadTempDirs", () => {
  it("removes old upload temp folders and keeps recent and unrelated ones", async () => {
    const old = makeDir("orison-mobile-upload-abc", 3 * 3600_000);
    const oldPoster = makeDir("orison-poster-def", 2 * 3600_000);
    const fresh = makeDir("orison-mobile-upload-new", 60_000);
    const other = makeDir("something-else", 5 * 3600_000);
    const removed = await removeStaleUploadTempDirs({ root, minAgeMs: 3600_000 });
    assert.deepEqual(removed.sort(), [old, oldPoster].sort());
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(other), true);
  });
});
