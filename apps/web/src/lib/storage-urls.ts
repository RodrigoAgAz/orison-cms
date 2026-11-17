// Stored loop URLs (Loop.manifestUrl, Loop.compiledVideoUrl and the URLs inside manifest files) are
// absolute and were frozen with whatever APP_URL was at publish time. URLs that point at this
// app's own /api/storage/ route are re-pointed at the origin the request came in on when they are
// served, so a change of domain does not break published loops. Other URLs (a CDN) are left alone.

const STORAGE_PATH_PREFIX = "/api/storage/";

/** The origin the client used (behind Railway's proxy: X-Forwarded-Proto / -Host). */
export function requestOrigin(request: Request, fallback: string) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (!host || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
    return fallback.replace(/\/$/, "");
  }
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto =
    forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function rebaseStorageUrl(value: string, origin: string): string;
export function rebaseStorageUrl(value: string | null, origin: string): string | null;
export function rebaseStorageUrl(value: string | null, origin: string) {
  if (!value) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.pathname.startsWith(STORAGE_PATH_PREFIX)) {
    return value;
  }
  return `${origin.replace(/\/$/, "")}${url.pathname}${url.search}`;
}

/** Rebase every storage URL string inside a parsed JSON document (a manifest file). */
export function rebaseStorageUrlsDeep<T>(value: T, origin: string): T {
  if (typeof value === "string") {
    return rebaseStorageUrl(value, origin) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rebaseStorageUrlsDeep(item, origin)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, rebaseStorageUrlsDeep(item, origin)]),
    ) as T;
  }
  return value;
}

/** Storage keys of published manifest files (lib/loops.ts writes them under manifests/). */
export function isManifestKey(key: string) {
  return key.startsWith("manifests/") && key.endsWith(".json");
}
