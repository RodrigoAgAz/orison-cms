// The phone app's rules for uploads in pieces (lib/chunked-upload.ts does the piece handling):
// who may upload, what is checked before any byte is sent, when an upload counts towards the
// anonymous ceiling (once per video, when its session is first opened), and what happens to the
// joined file (the same pipeline as always: a PUBLISHING loop, the upload queue, the target).
//
// Like every route, these run through the middleware (each piece is at most a few MB, so Next
// buffering it there costs little; see src/middleware.ts), and every route also checks access
// itself with requirePhoneAppActor().

import path from "node:path";

import { z } from "zod";

import { createLoopSchema, directLoopUploadMaxBytes, directLoopUploadMaxDurationMs } from "@orison/shared";

import { assignTargetSchema, describeTarget, type AssignTarget } from "@/lib/assignment";
import type { PhoneActor } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { processSingleton } from "@/lib/job-limits";
import { createPendingUploadLoop, directLoopUploadExtensions, startUploadedLoopProcessing } from "@/lib/loops";
import { anonymousUploadLimitFrom, createRollingLimit, uploadLimitMessage } from "@/lib/phone-access";
import { looksLikeIsoMediaFile } from "@/lib/upload-stream";

export const limitsMessage = `Videos must be MP4, MOV or M4V, up to ${Math.round(
  directLoopUploadMaxBytes / (1024 * 1024),
)}MB and ${Math.round(directLoopUploadMaxDurationMs / 60000)} minutes long.`;

export const notAVideoMessage = `This file is not a supported video. ${limitsMessage}`;

/** Folder prefix of the joined file; the server's start-up cleanup (lib/upload-temp.ts) knows it. */
export const JOINED_TEMP_PREFIX = "orison-mobile-upload-";

// Uploads made without signing in (open phone app): at most PHONE_APP_ANON_UPLOADS_PER_HOUR in any
// rolling hour, across all such callers, so a stranger cannot fill storage or keep the server
// transcoding. Counted once per video, when its upload is first opened (carrying on with the same
// file does not count again). Signed-in users are not limited. In memory: one Node process.
const anonymousUploads = processSingleton("anonymous-upload-limit", () =>
  createRollingLimit({
    limit: anonymousUploadLimitFrom(process.env.PHONE_APP_ANON_UPLOADS_PER_HOUR),
    windowMs: 60 * 60 * 1000,
  }),
);

export function enforceAnonymousUploadLimit(actor: PhoneActor, mode: "check" | "take") {
  if (!actor.anonymous) {
    return;
  }
  const result = mode === "take" ? anonymousUploads.take() : anonymousUploads.check();
  if (!result.allowed) {
    throw new ApiError(uploadLimitMessage(result.limit, result.retryAfterMs), 429, {
      retryAfterSeconds: Math.ceil(result.retryAfterMs / 1000),
    });
  }
}

export const openUploadSchema = z.object({
  name: z.string(),
  fileName: z.string().min(1).max(255),
  size: z.number().int().min(0),
  fingerprint: z.string().min(8).max(200),
  target: assignTargetSchema.nullable().optional(),
});

/** Same checks as before a single-request upload: name, file type, target exists. */
export async function checkUploadDetails(input: { name: string; fileName: string; target?: AssignTarget | null }) {
  const nameResult = createLoopSchema.safeParse({ name: input.name.trim() });
  if (!nameResult.success) {
    throw new ApiError("Give the video a name (2-120 characters)", 400, nameResult.error.flatten());
  }
  const extension = path.extname(input.fileName).toLowerCase();
  if (!(directLoopUploadExtensions as readonly string[]).includes(extension)) {
    throw new ApiError(limitsMessage, 400);
  }
  const target = input.target ?? null;
  if (target) {
    await describeTarget(target); // 404 early for an unknown group/cab
  }
  return { name: nameResult.data.name, fileName: input.fileName, target };
}

/** What the session keeps for the phone app. */
export type PhoneUploadData = {
  name: string;
  target: AssignTarget | null;
  /** A change to the same target after this moment wins over the upload. */
  requestedAt: string;
  loopId?: string;
};

/** The first piece must start like an MP4/MOV, so a wrong file is refused before the rest is sent. */
export async function checkPiece(index: number, filePath: string) {
  if (index === 0 && !(await looksLikeIsoMediaFile(filePath))) {
    throw new ApiError(notAVideoMessage, 415);
  }
}

/** The joined file goes through the same pipeline as a single-request upload did. */
export async function processJoinedUpload(
  file: { tempDir: string; filePath: string; meta: { fileName: string; data: PhoneUploadData } },
  actor: PhoneActor,
) {
  if (!(await looksLikeIsoMediaFile(file.filePath))) {
    throw new ApiError(notAVideoMessage, 415);
  }
  const { data } = file.meta;
  const loop = await createPendingUploadLoop({
    name: data.name,
    pendingTarget: data.target,
    requestedAt: new Date(data.requestedAt),
  });
  startUploadedLoopProcessing({
    loopId: loop.id,
    originalFilename: file.meta.fileName,
    tempFilePath: file.filePath,
    tempDir: file.tempDir,
    publishedBy: {
      id: actor.id,
      name: actor.name,
      anonymous: actor.anonymous,
      ip: actor.ip,
      forwardedFor: actor.forwardedFor,
    },
  });
  return { loopId: loop.id };
}

export function sessionView(session: {
  id: string;
  size: number;
  pieceBytes: number;
  pieceCount: number;
  received: number[];
  receivedBytes: number;
  status: string;
  data: PhoneUploadData;
}) {
  return {
    uploadId: session.id,
    size: session.size,
    pieceBytes: session.pieceBytes,
    pieceCount: session.pieceCount,
    received: session.received,
    receivedBytes: session.receivedBytes,
    status: session.status,
    loopId: session.data.loopId ?? null,
  };
}
