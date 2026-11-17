import { requirePhoneAppActor } from "@/lib/auth";
import { finishUploadSession } from "@/lib/chunked-upload";
import { apiError, apiResponse } from "@/lib/http";

import { JOINED_TEMP_PREFIX, processJoinedUpload, type PhoneUploadData } from "../../phone-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * All pieces are here: join them and prepare the video exactly as a single-request upload was
 * (202 { loopId }). Asking again after a lost answer returns the same loopId; it never makes a
 * second video.
 */
export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    const actor = await requirePhoneAppActor();
    const result = await finishUploadSession<PhoneUploadData, { loopId: string }>({
      id: params.id,
      tempPrefix: JOINED_TEMP_PREFIX,
      consume: (file) => processJoinedUpload(file, actor),
      storeResult: (data, value) => ({ ...data, loopId: value.loopId }),
      readResult: (data) => (data.loopId ? { loopId: data.loopId } : null),
    });
    return apiResponse(result, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
