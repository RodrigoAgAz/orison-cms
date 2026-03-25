import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function writeUploadedFileToTemp(file: File) {
  const tempDir = path.join(os.tmpdir(), "orison-uploads");
  await mkdir(tempDir, { recursive: true });
  const tempFilePath = path.join(tempDir, `${randomUUID()}-${file.name}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(tempFilePath, buffer);
  return {
    buffer,
    tempFilePath,
  };
}

