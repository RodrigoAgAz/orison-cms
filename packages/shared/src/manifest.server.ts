import { createHash } from "node:crypto";

export function checksumJson(payload: unknown) {
  const body = JSON.stringify(payload);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}
