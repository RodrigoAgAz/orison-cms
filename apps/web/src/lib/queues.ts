import { Queue } from "bullmq";
import IORedis from "ioredis";

import { queueNames, type AssetProcessingJob, type PublishLoopJob } from "@orison/shared";

import { env } from "./env";

let connection: IORedis | null = null;
const queues = new Map<string, Queue>();

function getConnection() {
  if (!env.redisUrl) {
    return null;
  }

  if (!connection) {
    connection = new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
    });
  }

  return connection;
}

function getQueue(name: string) {
  const existing = queues.get(name);
  if (existing) {
    return existing;
  }

  const redis = getConnection();
  if (!redis) {
    return null;
  }

  const queue = new Queue(name, { connection: redis });
  queues.set(name, queue);
  return queue;
}

export async function enqueueAssetProcessingJob(payload: AssetProcessingJob) {
  const queue = getQueue(queueNames.assetProcessing);
  if (!queue) {
    return false;
  }

  await queue.add("asset.process", payload, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 10_000,
    },
  });

  return true;
}

export async function enqueueLoopPublishJob(payload: PublishLoopJob) {
  const queue = getQueue(queueNames.loopPublish);
  if (!queue) {
    return false;
  }

  await queue.add("loop.publish", payload, {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 30_000,
    },
  });

  return true;
}

