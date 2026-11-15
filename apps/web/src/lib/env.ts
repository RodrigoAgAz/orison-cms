function optionalEnv(name: string) {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function requiredEnv(name: string, fallback?: string) {
  return optionalEnv(name) ?? fallback ?? "";
}

export const env = {
  appUrl: requiredEnv("APP_URL", "http://localhost:3000"),
  sessionCookieName: requiredEnv("APP_SESSION_COOKIE", "orison_session"),
  sessionSecret: requiredEnv("NEXTAUTH_SECRET", "development-session-secret"),
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
};

export const hasS3Config = Boolean(
  env.s3Bucket && env.awsAccessKeyId && env.awsSecretAccessKey,
);

