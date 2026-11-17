function optionalEnv(name: string) {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function requiredEnv(name: string, fallback?: string) {
  return optionalEnv(name) ?? fallback ?? "";
}

/** Whole days from an env var: unset/blank/invalid -> fallback; otherwise at least `minimum`. */
function daysEnv(name: string, fallback: number | null, minimum: number) {
  const raw = optionalEnv(name);
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? Math.max(value, minimum) : fallback;
}

export const env = {
  appUrl: requiredEnv("APP_URL", "http://localhost:3000"),
  sessionCookieName: requiredEnv("APP_SESSION_COOKIE", "orison_session"),
  // SESSION_SECRET signs the sign-in cookie. NEXTAUTH_SECRET is the old name (this app never used
  // NextAuth) and is still read so existing deployments keep their sessions.
  sessionSecret: optionalEnv("SESSION_SECRET") ?? requiredEnv("NEXTAUTH_SECRET", "development-session-secret"),
  databaseUrl: requiredEnv("DATABASE_URL", "postgresql://orison:password@localhost:5432/orison_cms"),
  redisUrl: optionalEnv("REDIS_URL"),
  s3Bucket: optionalEnv("S3_BUCKET"),
  s3Region: requiredEnv("S3_REGION", "eu-west-2"),
  s3Endpoint: optionalEnv("AWS_ENDPOINT"),
  cdnBaseUrl: optionalEnv("CDN_BASE_URL"),
  awsAccessKeyId: optionalEnv("AWS_ACCESS_KEY_ID"),
  awsSecretAccessKey: optionalEnv("AWS_SECRET_ACCESS_KEY"),
  deviceSharedToken: requiredEnv("DEVICE_SHARED_TOKEN", "replace-with-device-shared-secret"),
  inlineMediaJobs: requiredEnv("INLINE_MEDIA_JOBS", "true") === "true",
  // Cell tower geolocation (heartbeats without a GPS fix).
  openCellIdApiKey: optionalEnv("OPENCELLID_API_KEY"),
  cellLookupDisablePublic: requiredEnv("CELL_LOOKUP_DISABLE_PUBLIC", "false") === "true",
  cellLookupBeaconDbUrl: requiredEnv("CELL_LOOKUP_BEACONDB_URL", "https://api.beacondb.net/v1/geolocate"),
  cellLookupTimeoutMs: Number.parseInt(requiredEnv("CELL_LOOKUP_TIMEOUT_MS", "3000"), 10) || 3000,
  cellLookupUserAgent: requiredEnv("CELL_LOOKUP_USER_AGENT", "cab-screen-cms/1.0 (cell tower lookup)"),
  // Daily pruning (lib/retention.ts). Heartbeats: default 90 days, never below 30 (the phone app's
  // cab history). Playback logs are billing evidence: kept forever unless set (minimum 30).
  heartbeatRetentionDays: daysEnv("HEARTBEAT_RETENTION_DAYS", 90, 30),
  playbackLogRetentionDays: daysEnv("PLAYBACK_LOG_RETENTION_DAYS", null, 30),
};

export const hasS3Config = Boolean(
  env.s3Bucket && env.awsAccessKeyId && env.awsSecretAccessKey,
);

