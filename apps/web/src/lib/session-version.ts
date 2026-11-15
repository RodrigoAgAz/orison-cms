/**
 * Session revocation rule. A session token carries the user's `sessionVersion` at sign-in (`sv`);
 * bumping the stored version (password change, admin reset, role change) invalidates every older
 * token. Tokens issued before versions existed carry no `sv` and count as version 0, so deploying
 * this does not sign anyone out.
 */
export function sessionVersionMatches(tokenVersion: unknown, userVersion: number) {
  const version = tokenVersion === undefined || tokenVersion === null ? 0 : tokenVersion;
  return typeof version === "number" && Number.isInteger(version) && version === userVersion;
}
