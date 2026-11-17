import { requireApiUser } from "@/lib/auth";
import { getUploadSession, putUploadPiece, uploadSessionsRoot } from "@/lib/chunked-upload";
import { apiError, apiResponse, ApiError } from "@/lib/http";

import { DESKTOP_UPLOAD_SCOPE, pieceCheckFor, type DesktopUploadData } from "../../../desktop-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One piece of the file (raw body, at most PIECE_BYTES). X-Piece-Sha256 (hex) is checked when sent.
 * Sending a piece the server already has is harmless. Answers with the pieces received so far.
 */
export async function PUT(request: Request, { params }: { params: { id: string; index: string } }) {
  try {
    await requireApiUser();
    if (!/^\d{1,6}$/.test(params.index)) throw new ApiError("Invalid piece number", 400);
    const session = await getUploadSession<DesktopUploadData>(params.id, uploadSessionsRoot(), DESKTOP_UPLOAD_SCOPE);
    const state = await putUploadPiece({
      id: params.id,
      index: Number(params.index),
      body: request.body,
      sha256: request.headers.get("x-piece-sha256"),
      scope: DESKTOP_UPLOAD_SCOPE,
      check: pieceCheckFor(session.data),
    });
    return apiResponse({ received: state.received.length, receivedBytes: state.receivedBytes, pieceCount: state.pieceCount });
  } catch (error) {
    return apiError(error);
  }
}
