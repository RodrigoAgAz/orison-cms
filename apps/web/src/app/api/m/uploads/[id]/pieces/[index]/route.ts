import { requirePhoneAppActor } from "@/lib/auth";
import { putUploadPiece } from "@/lib/chunked-upload";
import { apiError, apiResponse, ApiError } from "@/lib/http";

import { checkPiece } from "../../../phone-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One piece of the file (raw body, at most a few MB). X-Piece-Sha256 (hex) is checked when sent.
 * Sending a piece the server already has is harmless. Answers with the pieces received so far.
 */
export async function PUT(request: Request, { params }: { params: { id: string; index: string } }) {
  try {
    await requirePhoneAppActor();
    if (!/^\d{1,6}$/.test(params.index)) throw new ApiError("Invalid piece number", 400);
    const session = await putUploadPiece({
      id: params.id,
      index: Number(params.index),
      body: request.body,
      sha256: request.headers.get("x-piece-sha256"),
      check: checkPiece,
    });
    return apiResponse({ received: session.received.length, receivedBytes: session.receivedBytes, pieceCount: session.pieceCount });
  } catch (error) {
    return apiError(error);
  }
}
