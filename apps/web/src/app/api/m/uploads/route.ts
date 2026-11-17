import { directLoopUploadMaxBytes } from "@orison/shared";

import { requirePhoneAppActor } from "@/lib/auth";
import { openUploadSession } from "@/lib/chunked-upload";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

import { checkUploadDetails, enforceAnonymousUploadLimit, limitsMessage, openUploadSchema, sessionView, type PhoneUploadData } from "./phone-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start (or carry on) a phone upload: checks everything that can be checked before a byte is sent
 * (allowed to upload, name, file type, size, target exists, anonymous ceiling) and answers with
 * the piece size and the pieces the server already has for this file (none for a new one).
 * Body: { name, fileName, size, fingerprint, target }.
 */
export async function POST(request: Request) {
  try {
    const actor = await requirePhoneAppActor();
    const body = await parseJsonBody(request, openUploadSchema).catch((error) => {
      if (error instanceof SyntaxError) throw new ApiError("Request body must be JSON", 400);
      throw error;
    });
    const details = await checkUploadDetails(body);
    // Refuse early, before anything is stored; counted below only for a new video.
    enforceAnonymousUploadLimit(actor, "check");
    const data: PhoneUploadData = { name: details.name, target: details.target, requestedAt: new Date().toISOString() };
    const { session, isNew } = await openUploadSession({
      fingerprint: body.fingerprint,
      fileName: details.fileName,
      size: body.size,
      maxBytes: directLoopUploadMaxBytes,
      tooLargeMessage: limitsMessage,
      data,
    });
    if (isNew) {
      enforceAnonymousUploadLimit(actor, "take");
    }
    return apiResponse({ ...sessionView(session), resumed: !isNew }, { status: isNew ? 201 : 200 });
  } catch (error) {
    return apiError(error);
  }
}
