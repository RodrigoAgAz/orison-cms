import { requirePhoneAppActor } from "@/lib/auth";
import { cancelUploadSession, getUploadSession } from "@/lib/chunked-upload";
import { apiError, apiResponse } from "@/lib/http";

import { sessionView, type PhoneUploadData } from "../phone-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which pieces the server has, and the video's id once finished. 404: gone (expired or restart). */
export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    await requirePhoneAppActor();
    return apiResponse(sessionView(await getUploadSession<PhoneUploadData>(params.id)));
  } catch (error) {
    return apiError(error);
  }
}

/** Cancel: the pieces are deleted. */
export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  try {
    await requirePhoneAppActor();
    await cancelUploadSession(params.id);
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
