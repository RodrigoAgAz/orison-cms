import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DESKTOP_PUBLISH_ERROR_MESSAGE, phoneLoopProcessing } from "../src/lib/mobile";
import {
  anonymousUploadLimitFrom,
  createRollingLimit,
  DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR,
  isPhoneAppApiRoute,
  isPhoneAppPage,
  isSharedPhoneActorId,
  phoneAppRequiresSignIn,
  requestAddress,
  SHARED_PHONE_ACTOR,
  uploadLimitMessage,
} from "../src/lib/phone-access";

describe("phoneAppRequiresSignIn", () => {
  it("is open by default (unset, empty, false)", () => {
    assert.equal(phoneAppRequiresSignIn(undefined), false);
    assert.equal(phoneAppRequiresSignIn(null), false);
    assert.equal(phoneAppRequiresSignIn(""), false);
    assert.equal(phoneAppRequiresSignIn("false"), false);
    assert.equal(phoneAppRequiresSignIn("0"), false);
    assert.equal(phoneAppRequiresSignIn("no"), false);
  });
  it("requires sign-in for true-ish values, ignoring case and spaces", () => {
    for (const value of ["true", "TRUE", " True ", "1", "yes", "on"]) {
      assert.equal(phoneAppRequiresSignIn(value), true, value);
    }
  });
});

describe("isPhoneAppPage", () => {
  it("matches the phone app's pages only", () => {
    assert.equal(isPhoneAppPage("/m"), true);
    assert.equal(isPhoneAppPage("/m/"), true);
    assert.equal(isPhoneAppPage("/m/account/team"), true);
    assert.equal(isPhoneAppPage("/m-app/icon-192.png"), false);
    assert.equal(isPhoneAppPage("/media"), false);
    assert.equal(isPhoneAppPage("/devices"), false);
    assert.equal(isPhoneAppPage("/"), false);
  });
});

describe("isPhoneAppApiRoute", () => {
  it("opens the phone app's own API", () => {
    assert.equal(isPhoneAppApiRoute("GET", "/api/m/overview"), true);
    assert.equal(isPhoneAppApiRoute("GET", "/api/m/loops"), true);
    assert.equal(isPhoneAppApiRoute("GET", "/api/m/loops/abc"), true);
    assert.equal(isPhoneAppApiRoute("GET", "/api/m/loops/abc/poster"), true);
    assert.equal(isPhoneAppApiRoute("POST", "/api/m/loops/abc/archive"), true);
    assert.equal(isPhoneAppApiRoute("GET", "/api/m/cabs/abc"), true);
    assert.equal(isPhoneAppApiRoute("POST", "/api/m/assign"), true);
    assert.equal(isPhoneAppApiRoute("GET", "/api/auth/me"), true);
  });
  it("opens pause/resume of one cab for POST (phone) but not PUT (desktop)", () => {
    assert.equal(isPhoneAppApiRoute("POST", "/api/devices/abc/disable"), true);
    assert.equal(isPhoneAppApiRoute("post", "/api/devices/abc/enable"), true);
    assert.equal(isPhoneAppApiRoute("PUT", "/api/devices/abc/disable"), false);
    assert.equal(isPhoneAppApiRoute("PUT", "/api/devices/abc/enable"), false);
  });
  it("keeps team management, passwords and desktop-only routes closed", () => {
    const closed: Array<[string, string]> = [
      ["GET", "/api/users"],
      ["POST", "/api/users"],
      ["PATCH", "/api/users/abc"],
      ["DELETE", "/api/users/abc"],
      ["POST", "/api/auth/password"],
      ["POST", "/api/auth/me"],
      ["POST", "/api/devices/disable-all"],
      ["POST", "/api/devices/enable-all"],
      ["GET", "/api/devices"],
      ["POST", "/api/devices"],
      ["PATCH", "/api/devices/abc"],
      ["DELETE", "/api/devices/abc"],
      ["POST", "/api/devices/abc/disable/extra"],
      ["GET", "/api/settings"],
      ["GET", "/api/loops"],
      ["GET", "/api/assets"],
      ["GET", "/api/analytics"],
      ["GET", "/api/device-groups"],
      ["GET", "/api/mx"],
      ["GET", "/api/m"],
    ];
    for (const [method, path] of closed) {
      assert.equal(isPhoneAppApiRoute(method, path), false, `${method} ${path}`);
    }
  });
});

describe("shared identity", () => {
  it("cannot collide with a generated user id and is never an admin", () => {
    assert.match(SHARED_PHONE_ACTOR.id, /:/);
    assert.equal(SHARED_PHONE_ACTOR.role, "EDITOR");
    assert.equal(isSharedPhoneActorId(SHARED_PHONE_ACTOR.id), true);
    assert.equal(isSharedPhoneActorId("clx0abc123"), false);
    assert.match(SHARED_PHONE_ACTOR.name, /not signed in/i);
  });
});

describe("requestAddress", () => {
  const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name.toLowerCase()] ?? null });
  it("takes the first forwarded address and keeps the whole chain", () => {
    assert.deepEqual(requestAddress(headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" })), {
      ip: "203.0.113.9",
      forwardedFor: "203.0.113.9, 10.0.0.2",
    });
  });
  it("falls back to X-Real-IP, then unknown", () => {
    assert.deepEqual(requestAddress(headers({ "x-real-ip": "198.51.100.4" })), { ip: "198.51.100.4", forwardedFor: null });
    assert.deepEqual(requestAddress(headers({})), { ip: "unknown", forwardedFor: null });
  });
  it("bounds what it stores", () => {
    const long = `${"1".repeat(500)}, 2`;
    const result = requestAddress(headers({ "x-forwarded-for": long }));
    assert.equal(result.ip.length, 100);
    assert.equal(result.forwardedFor?.length, 300);
  });
});

describe("createRollingLimit", () => {
  const hour = 3_600_000;
  it("allows up to the limit in a window, then refuses until the oldest leaves the window", () => {
    const limit = createRollingLimit({ limit: 3, windowMs: hour });
    assert.equal(limit.take(0).allowed, true);
    assert.equal(limit.take(10 * 60_000).allowed, true);
    assert.equal(limit.take(20 * 60_000).allowed, true);
    const refused = limit.take(30 * 60_000);
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterMs, 30 * 60_000); // the first upload leaves the window at 60 min
    assert.equal(limit.check(hour - 1).allowed, false);
    assert.equal(limit.check(hour + 1).allowed, true);
    assert.equal(limit.take(hour + 1).used, 3);
    assert.equal(limit.take(hour + 2).allowed, false);
  });
  it("check does not use up a slot; refusals are not counted", () => {
    const limit = createRollingLimit({ limit: 1, windowMs: hour });
    assert.equal(limit.check(0).allowed, true);
    assert.equal(limit.check(1).allowed, true);
    assert.equal(limit.take(2).allowed, true);
    for (let i = 0; i < 5; i++) assert.equal(limit.take(3 + i).allowed, false);
    assert.equal(limit.take(hour + 3).allowed, true);
  });
  it("a limit of 0 refuses everything", () => {
    const limit = createRollingLimit({ limit: 0, windowMs: hour });
    assert.equal(limit.take(0).allowed, false);
  });
});

describe("anonymousUploadLimitFrom", () => {
  it("parses the setting with a generous default", () => {
    assert.equal(anonymousUploadLimitFrom(undefined), DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR);
    assert.equal(anonymousUploadLimitFrom(""), DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR);
    assert.equal(anonymousUploadLimitFrom("abc"), DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR);
    assert.equal(anonymousUploadLimitFrom("-1"), DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR);
    assert.equal(anonymousUploadLimitFrom("5"), 5);
    assert.equal(anonymousUploadLimitFrom("0"), 0);
    assert.ok(DEFAULT_ANONYMOUS_UPLOADS_PER_HOUR >= 10, "three people should never reach it");
  });
  it("explains the limit and when to try again", () => {
    const message = uploadLimitMessage(20, 90_000);
    assert.match(message, /20 video uploads in the last hour/);
    assert.match(message, /2 minutes/);
    assert.match(uploadLimitMessage(20, 1000), /1 minute\b/);
  });
});

describe("phoneLoopProcessing", () => {
  const base = { state: "ready" as const, waiting: false, queuedBehind: 0 };
  it("hides the raw text of a desktop publish failure", () => {
    const result = phoneLoopProcessing({ ...base, error: "ffmpeg exited with code 1: /tmp/orison-x/a.mp4" }, { autoLive: true });
    assert.equal(result.error, DESKTOP_PUBLISH_ERROR_MESSAGE);
  });
  it("keeps phone upload messages (written for the phone) and loops without errors", () => {
    const upload = { ...base, state: "failed" as const, error: "This file does not contain a video track" };
    assert.deepEqual(phoneLoopProcessing(upload, { autoLive: false }), upload);
    assert.deepEqual(phoneLoopProcessing({ ...base, error: null }, { autoLive: true }), { ...base, error: null });
  });
});
