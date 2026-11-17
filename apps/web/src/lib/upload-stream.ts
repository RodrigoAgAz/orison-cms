import { open } from "node:fs/promises";

// Uploads arrive in pieces (lib/chunked-upload.ts); this only sniffs what a file is.

// ISO-BMFF / QuickTime top-level atom types that can start an mp4/mov/m4v file.
const leadingAtoms = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot", "uuid"]);

/** Cheap sniff: does the file look like an MP4/MOV container? */
export async function looksLikeIsoMediaFile(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    if (bytesRead < 8) {
      return false;
    }
    return leadingAtoms.has(buffer.subarray(4, 8).toString("latin1"));
  } finally {
    await handle.close();
  }
}
