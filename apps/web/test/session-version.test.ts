import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionVersionMatches } from "../src/lib/session-version";

describe("sessionVersionMatches", () => {
  it("accepts a token carrying the current version", () => {
    assert.equal(sessionVersionMatches(3, 3), true);
  });
  it("rejects a token from before a password change, reset or role change", () => {
    assert.equal(sessionVersionMatches(2, 3), false);
    assert.equal(sessionVersionMatches(0, 1), false);
  });
  it("treats tokens issued before versions existed as version 0 (no forced sign-out on deploy)", () => {
    assert.equal(sessionVersionMatches(undefined, 0), true);
    assert.equal(sessionVersionMatches(null, 0), true);
    assert.equal(sessionVersionMatches(undefined, 1), false);
  });
  it("rejects malformed versions", () => {
    assert.equal(sessionVersionMatches("0", 0), false);
    assert.equal(sessionVersionMatches(0.5, 0), false);
  });
});
