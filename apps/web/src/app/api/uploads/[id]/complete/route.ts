import { requireApiUser } from "@/lib/auth";
import { finishUploadSession, getUploadSession, uploadSessionsRoot } from "@/lib/chunked-upload";
import { apiError, apiResponse } from "@/lib/http";

import {
  DESKTOP_UPLOAD_SCOPE,
  JOINED_TEMP_PREFIX,
  processJoinedUpload,
  readResult,
  storeResult,
  type DesktopUploadData,
} from "../../desktop-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * All pieces are here: join them and start processing in the background (202). An asset answers
 * { kind: "asset", assetId, filename }, a pre-built loop { kind: "loop", loopId }. Asking again
 * after a lost answer returns the same result; it never makes a second asset or loop.
 */
export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireApiUser();
    const session = await getUploadSession<DesktopUploadData>(params.id, uploadSessionsRoot(), DESKTOP_UPLOAD_SCOPE);
    const result = await finishUploadSession<DesktopUploadData, Awaited<ReturnType<typeof processJoinedUpload>>>({
      id: params.id,
      scope: DESKTOP_UPLOAD_SCOPE,
      tempPrefix: JOINED_TEMP_PREFIX[session.data.kind],
      consume: (file) => processJoinedUpload(file, user),
      storeResult,
      readResult,
    });
    return apiResponse(result, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
