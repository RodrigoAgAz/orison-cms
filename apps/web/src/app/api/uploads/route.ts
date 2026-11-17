import { directLoopUploadMaxBytes } from "@orison/shared";

import { requireApiUser } from "@/lib/auth";
import { openUploadSession } from "@/lib/chunked-upload";
import { apiError, apiResponse, ApiError, parseJsonBody } from "@/lib/http";

import { checkUploadDetails, DESKTOP_UPLOAD_SCOPE, openUploadSchema, sessionView } from "./desktop-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start (or carry on) a desktop upload in pieces: an asset for the library or a pre-built loop.
 * Checks everything that can be checked before a byte is sent and answers with the piece size and
 * the pieces the server already has for this file (none for a new one). Body: see openUploadSchema.
 */
export async function POST(request: Request) {
  try {
    await requireApiUser();
    const body = await parseJsonBody(request, openUploadSchema).catch((error) => {
      if (error instanceof SyntaxError) throw new ApiError("Request body must be JSON", 400);
      throw error;
    });
    const { data, tooLargeMessage } = await checkUploadDetails(body);
    const { session, isNew } = await openUploadSession({
      scope: DESKTOP_UPLOAD_SCOPE,
      fingerprint: `${body.kind}:${body.fingerprint}`,
      fileName: body.fileName,
      size: body.size,
      maxBytes: directLoopUploadMaxBytes,
      tooLargeMessage,
      data,
    });
    return apiResponse({ ...sessionView(session), resumed: !isNew }, { status: isNew ? 201 : 200 });
  } catch (error) {
    return apiError(error);
  }
}
