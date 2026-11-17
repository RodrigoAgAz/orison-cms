// The phone app's use of the shared piece sender (lib/piece-sender.ts): its upload routes live
// under /api/m/uploads, the open request carries the video's name and where it should play, and
// the finished upload answers with the new video's id.

import {
  sendFileInPieces,
  type SendFileOptions,
} from "../../lib/piece-sender";

import type { AssignTarget } from "./types";

export {
  COMPLETE_TIMEOUT_MS,
  CONTROL_TIMEOUT_MS,
  fileFingerprint,
  MAX_RESTARTS,
  PIECE_TIMEOUT_MS,
  sha256Hex,
  UploadCancelled,
  UploadRefused,
  type OpenAnswer,
  type SendEvents,
} from "../../lib/piece-sender";

export const PHONE_UPLOADS_URL = "/api/m/uploads";

export type SendOptions = Omit<SendFileOptions, "baseUrl" | "open"> & {
  name: string;
  target: AssignTarget | null;
};

/** Send a video from the phone; resolves with its id once the server has started preparing it. */
export async function sendInPieces(options: SendOptions): Promise<{ loopId: string }> {
  const { name, target, ...rest } = options;
  const body = await sendFileInPieces({ ...rest, baseUrl: PHONE_UPLOADS_URL, open: { name, target } });
  return { loopId: String(body.loopId) };
}
