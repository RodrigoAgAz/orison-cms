import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

// A file that git ignores exists on the developer's disk, so every local test passes, but it is
// absent from what gets built and deployed. This happened: a bare `uploads` line in .gitignore
// swallowed the upload API routes and production answered 404 for every upload.
describe("source files", () => {
  it("none are ignored by git", () => {
    const root = path.resolve(__dirname, "../../..");
    let output = "";
    try {
      output = execFileSync(
        "git",
        ["ls-files", "--others", "--ignored", "--exclude-standard", "--", "apps/web/src", "apps/web/scripts", "apps/web/public", "apps/web/assets", "packages", "device", "scripts"],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      return; // not a git checkout (for example inside the built image): nothing to check
    }
    const ignored = output
      .split("\n")
      .filter(Boolean)
      .filter((file) => !/(^|\/)(node_modules|__pycache__|generated)\//.test(file) && !/\.(pyc|tsbuildinfo|log)$/.test(file) && file !== "device/config.json");
    assert.deepEqual(ignored, [], `git ignores these source files, so they would never be deployed:\n${ignored.join("\n")}`);
  });
});
