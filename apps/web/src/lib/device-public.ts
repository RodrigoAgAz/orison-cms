/**
 * Device rows as returned to browsers. Never include `apiTokenHash` (the bcrypt hash of the
 * device's own API token): it lets anyone who reads it attempt an offline guess of the token.
 */
export function publicDevice<T extends { apiTokenHash?: unknown }>(device: T): Omit<T, "apiTokenHash"> {
  const { apiTokenHash: _secret, ...rest } = device;
  return rest;
}
