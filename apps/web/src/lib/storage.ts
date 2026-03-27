import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { env, hasS3Config } from "./env";

const localStorageRoot = path.join(process.cwd(), "tmp", "storage");
const isProduction = process.env.NODE_ENV === "production";
const requiredProductionStorageEnvNames = [
  "S3_BUCKET",
  "S3_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

function productionStorageConfigError() {
  if (!isProduction) {
    return null;
  }

  const missing = requiredProductionStorageEnvNames.filter((name) => {
    const value = process.env[name];
    return !value || value.length === 0;
  });

  if (missing.length === 0 && hasS3Config && env.s3Bucket) {
    return null;
  }

  const details =
    missing.length > 0
      ? ` Missing: ${missing.join(", ")}.`
      : "";

  return new Error(
    `Object storage is required in production. Configure S3 via Railway variables before starting the app.${details}`,
  );
}

function requireObjectStorage() {
  const error = productionStorageConfigError();
  if (error) {
    throw error;
  }
}

const s3Client =
  hasS3Config && env.s3Bucket
    ? new S3Client({
        region: env.s3Region,
        endpoint: env.s3Endpoint,
        forcePathStyle: Boolean(env.s3Endpoint),
        credentials:
          env.awsAccessKeyId && env.awsSecretAccessKey
            ? {
                accessKeyId: env.awsAccessKeyId,
                secretAccessKey: env.awsSecretAccessKey,
              }
            : undefined,
      })
    : null;

export function hasRemoteObjectStorage() {
  return Boolean(s3Client && env.s3Bucket);
}

function localPathForKey(key: string) {
  const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(localStorageRoot, normalized);
}

export async function ensureStorageRoot() {
  requireObjectStorage();
  await mkdir(localStorageRoot, { recursive: true });
}

export async function putObject(options: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
  requireObjectStorage();

  if (s3Client && env.s3Bucket) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.s3Bucket,
        Key: options.key,
        Body: options.body,
        ContentType: options.contentType,
      }),
    );
    return;
  }

  const targetPath = localPathForKey(options.key);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, options.body);
}

export async function putObjectFromFile(options: {
  key: string;
  filePath: string;
  contentType: string;
}) {
  requireObjectStorage();
  const fileStats = await stat(options.filePath);

  if (s3Client && env.s3Bucket) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.s3Bucket,
        Key: options.key,
        Body: createReadStream(options.filePath),
        ContentType: options.contentType,
        ContentLength: fileStats.size,
      }),
    );
    return;
  }

  const targetPath = localPathForKey(options.key);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(options.filePath, targetPath);
}

export async function deleteObject(key: string) {
  requireObjectStorage();

  if (s3Client && env.s3Bucket) {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: env.s3Bucket,
        Key: key,
      }),
    );
    return;
  }

  await rm(localPathForKey(key), { force: true });
}

export function getPublicUrl(key: string) {
  requireObjectStorage();

  // Only emit CDN URLs when the app is actually backed by object storage.
  // In local development we persist to disk under tmp/storage, so assets must
  // be served back through the app itself.
  if (s3Client && env.s3Bucket && env.cdnBaseUrl) {
    return `${env.cdnBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  return `${env.appUrl.replace(/\/$/, "")}/api/storage/${key}`;
}

export async function getSignedAssetUrl(key: string, expiresIn = 60 * 60) {
  requireObjectStorage();

  if (s3Client && env.s3Bucket) {
    return getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: env.s3Bucket,
        Key: key,
      }),
      { expiresIn },
    );
  }

  return getPublicUrl(key);
}

export async function getStorageRouteRedirectUrl(key: string) {
  requireObjectStorage();

  if (hasRemoteObjectStorage()) {
    return getSignedAssetUrl(key);
  }

  return null;
}

async function responseBodyToBuffer(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readObject(key: string) {
  requireObjectStorage();

  if (s3Client && env.s3Bucket) {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: env.s3Bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`Missing body while reading ${key}`);
    }

    return responseBodyToBuffer(response.Body as Readable);
  }

  return readFile(localPathForKey(key));
}

export async function downloadObjectToFile(key: string, filePath: string) {
  requireObjectStorage();
  const buffer = await readObject(key);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
  return filePath;
}
