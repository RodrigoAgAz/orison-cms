// Poster stills for loops (the phone app's loop cards). A pre-built loop gets one frame; a
// slot-built loop gets a contact sheet of its first four distinct adverts, so two rotations that
// open with the same advert no longer look identical.

import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const POSTER_WIDTH = 640;

/**
 * A 640-px-wide JPEG made of frames of `videoPath` (a file or an http(s) URL) at `timesMs`:
 * one frame -> the frame; 2-4 frames -> a 2x2 grid (with 2 or 3 frames, repeated diagonally).
 */
export async function generateContactSheet(
  videoPath: string,
  timesMs: number[],
  outputPath: string,
  frame: { width: number; height: number },
) {
  const times = timesMs.length ? timesMs.slice(0, 4) : [1000];
  const isUrl = /^https?:\/\//.test(videoPath);
  const inputs = times.flatMap((time) => [
    ...(isUrl ? ["-rw_timeout", "30000000"] : []),
    "-ss",
    (time / 1000).toFixed(3),
    "-i",
    videoPath,
  ]);
  const height = Math.round((POSTER_WIDTH * frame.height) / frame.width / 2) * 2;
  let filter: string;
  if (times.length === 1) {
    filter = `[0:v]scale=${POSTER_WIDTH}:${height},setsar=1[out]`;
  } else {
    const tileWidth = POSTER_WIDTH / 2;
    const tileHeight = Math.round(height / 4) * 2;
    const order = times.length === 2 ? [0, 1, 1, 0] : times.length === 3 ? [0, 1, 2, 0] : [0, 1, 2, 3];
    const uses = new Map<number, number>();
    for (const index of order) uses.set(index, (uses.get(index) ?? 0) + 1);
    const parts: string[] = [];
    const labels: string[][] = [];
    for (const [index, count] of uses) {
      const names = Array.from({ length: count }, (_, copy) => `t${index}_${copy}`);
      labels[index] = names;
      parts.push(`[${index}:v]trim=end_frame=1,scale=${tileWidth}:${tileHeight},setsar=1${count > 1 ? `,split=${count}` : ""}${names.map((name) => `[${name}]`).join("")}`);
    }
    const next = new Map<number, number>();
    const ordered = order.map((index) => {
      const copy = next.get(index) ?? 0;
      next.set(index, copy + 1);
      return `[${labels[index][copy]}]`;
    });
    parts.push(`${ordered.join("")}xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]`);
    filter = parts.join(";");
  }
  await execFileAsync(
    "ffmpeg",
    ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", "-q:v", "4", outputPath],
    { timeout: 2 * 60 * 1000, killSignal: "SIGKILL" },
  );
}
