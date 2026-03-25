import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function localPathForKey(key: string) {
  const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(localStorageRoot, normalized);
}

export async function ensureStorageRoot() {
  await mkdir(localStorageRoot, { recursive: true });
}

export async function putObject(options: {
  key: string;
  body: Buffer;
  contentType: string;
}) {
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

export async function deleteObject(key: string) {
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
  // Only emit CDN URLs when the app is actually backed by object storage.
  // In local development we persist to disk under tmp/storage, so assets must
  // be served back through the app itself.
  if (s3Client && env.s3Bucket && env.cdnBaseUrl) {
    return `${env.cdnBaseUrl.replace(/\/$/, "")}/${key}`;
  }

  return `${env.appUrl.replace(/\/$/, "")}/api/storage/${key}`;
}

export async function getSignedAssetUrl(key: string, expiresIn = 60 * 60) {
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

export async function readLocalObject(key: string) {
  return readFile(localPathForKey(key));
}

export async function downloadObjectToFile(key: string, filePath: string) {
  if (s3Client && env.s3Bucket) {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: env.s3Bucket,
        Key: key,
      }),
    );

    if (!response.Body) {
      throw new Error(`Missing body while downloading ${key}`);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.concat(chunks));
    return filePath;
  }

  const buffer = await readFile(localPathForKey(key));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);
  return filePath;
}
