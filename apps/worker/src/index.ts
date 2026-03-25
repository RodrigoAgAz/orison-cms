import "dotenv/config";

import { Worker } from "bullmq";
import IORedis from "ioredis";

import {
  assetProcessingJobSchema,
  publishLoopJobSchema,
  queueNames,
} from "@orison/shared";

import { processAssetUpload } from "../../web/src/lib/media";
import { publishLoop } from "../../web/src/lib/loops";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is required to run the worker");
}

const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

function registerWorker(name: string, handler: (data: unknown) => Promise<unknown>) {
  const worker = new Worker(
    name,
    async (job) => {
      console.log(`[worker:${name}] processing ${job.name}`);
      return handler(job.data);
    },
    { connection },
  );

  worker.on("completed", (job) => {
    console.log(`[worker:${name}] completed ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[worker:${name}] failed ${job?.id}:`, error);
  });

  return worker;
}

registerWorker(queueNames.assetProcessing, async (data) => {
  const payload = assetProcessingJobSchema.parse(data);
  await processAssetUpload(payload.assetId, payload.tempFilePath);
});

registerWorker(queueNames.loopPublish, async (data) => {
  const payload = publishLoopJobSchema.parse(data);
  await publishLoop(payload.loopId, payload.publishedByUserId);
});

registerWorker(queueNames.weatherGeneration, async () => {
  console.log("[worker:weather-generation] placeholder processor");
});

registerWorker(queueNames.newsGeneration, async () => {
  console.log("[worker:news-generation] placeholder processor");
});

console.log("Orison worker online");

