import { requireApiUser } from "@/lib/auth";
import { cancelUploadSession, getUploadSession, uploadSessionsRoot } from "@/lib/chunked-upload";
import { apiError, apiResponse } from "@/lib/http";

import { DESKTOP_UPLOAD_SCOPE, sessionView, type DesktopUploadData } from "../desktop-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which pieces the server has, and the result once finished. 404: gone (expired or restart). */
export async function GET(_: Request, { params }: { params: { id: string } }) {
  try {
    await requireApiUser();
    return apiResponse(sessionView(await getUploadSession<DesktopUploadData>(params.id, uploadSessionsRoot(), DESKTOP_UPLOAD_SCOPE)));
  } catch (error) {
    return apiError(error);
  }
}

/** Cancel: the pieces are deleted. */
export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  try {
    await requireApiUser();
    await cancelUploadSession(params.id, uploadSessionsRoot(), DESKTOP_UPLOAD_SCOPE);
    return apiResponse({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
