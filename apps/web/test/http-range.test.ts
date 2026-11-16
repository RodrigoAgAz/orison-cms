import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRangeHeader } from "../src/lib/http-range";

describe("parseRangeHeader", () => {
  it("handles the common forms", () => {
    assert.deepEqual(parseRangeHeader("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRangeHeader("bytes=0-1", 1000), { start: 0, end: 1 });
    assert.deepEqual(parseRangeHeader("bytes=500-", 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRangeHeader("bytes=-100", 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRangeHeader("bytes=900-5000", 1000), { start: 900, end: 999 });
  });
  it("unsatisfiable and ignored ranges", () => {
    assert.equal(parseRangeHeader("bytes=1000-", 1000), "unsatisfiable");
    assert.equal(parseRangeHeader("bytes=-0", 1000), "unsatisfiable");
    assert.equal(parseRangeHeader("bytes=5-1", 1000), null);
    assert.equal(parseRangeHeader("bytes=0-1,5-6", 1000), null);
    assert.equal(parseRangeHeader("items=0-1", 1000), null);
    assert.equal(parseRangeHeader(null, 1000), null);
  });
});
