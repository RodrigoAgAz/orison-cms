import type { NextRequest } from "next/server";

import { ApiError } from "./http";
import { getRequestIp } from "./device-auth";

type BucketEntry = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, BucketEntry>();

function cleanupExpiredBuckets(now: number) {
  for (const [key, entry] of buckets.entries()) {
    if (entry.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export function enforceRateLimit(
  bucket: string,
  key: string,
  {
    limit,
    windowMs,
  }: {
    limit: number;
    windowMs: number;
  },
) {
  const now = Date.now();

  if (buckets.size > 1_000) {
    cleanupExpiredBuckets(now);
  }

  const bucketKey = `${bucket}:${key}`;
  const current = buckets.get(bucketKey);

  if (!current || current.resetAt <= now) {
    buckets.set(bucketKey, {
      count: 1,
      resetAt: now + windowMs,
    });
    return;
  }

  if (current.count >= limit) {
    throw new ApiError("Too many requests", 429);
  }

  current.count += 1;
  buckets.set(bucketKey, current);
}

export function enforceDeviceRateLimit(
  request: NextRequest,
  bucket: string,
  serialNumber: string,
  {
    limit,
    windowMs,
  }: {
    limit: number;
    windowMs: number;
  },
) {
  const ip = getRequestIp(request);
  enforceRateLimit(bucket, `${serialNumber}:${ip}`, { limit, windowMs });
}
