// Slot arithmetic and validation for slot-built loops. Pure and client-safe (no Node imports): the
// loop builder shows exactly what the server enforces. Unit-tested in test/slot-rules.test.ts.
//
// Rules (decided with the owner, see FIXES-LOOPS C2):
// - a loop has SLOT_COUNT slots of SLOT_DURATION_MS each; slot p starts at p x SLOT_DURATION_MS;
// - a slot holds at most one advert; to publish it holds exactly one, and its items add up to
//   exactly one slot length;
// - an advert takes the time of its file by default (rounded to DURATION_STEP_MS); staff may
//   shorten it. Fillers take the rest of the minute;
// - an item whose file is longer than its time is cut off at that time; one that is shorter is
//   held on its last frame (with silence) until its time is up. Still images show for their time.
// Loops built before these rules (adverts stored as 12 s whatever the file) stay valid: nothing
// here depends on an advert being 12 s.

export const SLOT_COUNT = 10;
export const SLOT_DURATION_MS = 60_000;
export const LOOP_FPS = 30;
export const FRAME_MS = 1000 / LOOP_FPS;
/** Durations chosen in the builder move in tenths of a second (3 frames at 30 fps). */
export const DURATION_STEP_MS = 100;
export const MIN_ITEM_DURATION_MS = 1_000;
/** A file within one frame of its time counts as an exact fit. */
export const FIT_TOLERANCE_MS = Math.ceil(FRAME_MS);

export type SlotContentType = "ADVERTISEMENT" | "FILLER";

export type RuleAsset = {
  id: string;
  filename?: string;
  mimeType: string;
  durationMs: number | null;
};

export type RuleContent = {
  assetId: string;
  orderInSlot: number;
  startTimeMs: number;
  durationMs: number;
  contentType: SlotContentType;
  asset?: RuleAsset | null;
};

export type Fit =
  | { kind: "still" }
  | { kind: "exact" }
  | { kind: "cut"; byMs: number }
  | { kind: "held"; byMs: number }
  | { kind: "unknown" };

export function isStillAsset(asset: Pick<RuleAsset, "mimeType">) {
  return asset.mimeType.startsWith("image/");
}

/** Round to the builder's step (0.1 s). */
export function roundToStep(ms: number) {
  return Math.round(ms / DURATION_STEP_MS) * DURATION_STEP_MS;
}

/**
 * How long an advert runs by default: the length of its file, rounded to 0.1 s, at least 1 s and
 * at most one slot. A still image (or a file of unknown length) defaults to 10 s.
 */
export function defaultAdvertDurationMs(asset: Pick<RuleAsset, "mimeType" | "durationMs">) {
  if (isStillAsset(asset) || !asset.durationMs || asset.durationMs <= 0) {
    return 10_000;
  }
  return Math.min(Math.max(roundToStep(asset.durationMs), MIN_ITEM_DURATION_MS), SLOT_DURATION_MS);
}

/** How a file fits the time it is given. */
export function fitOf(asset: Pick<RuleAsset, "mimeType" | "durationMs"> | null | undefined, durationMs: number): Fit {
  if (!asset) return { kind: "unknown" };
  if (isStillAsset(asset)) return { kind: "still" };
  if (!asset.durationMs || asset.durationMs <= 0) return { kind: "unknown" };
  const diff = asset.durationMs - durationMs;
  if (Math.abs(diff) <= FIT_TOLERANCE_MS) return { kind: "exact" };
  return diff > 0 ? { kind: "cut", byMs: diff } : { kind: "held", byMs: -diff };
}

export function formatSeconds(ms: number) {
  const seconds = ms / 1000;
  const text = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(Math.abs(ms % 100) === 0 ? 1 : 2);
  return `${text} s`;
}

/** Plain-words warning for an item whose file does not match its time, or null. */
export function fitWarning(content: Pick<RuleContent, "durationMs" | "contentType"> & { asset?: RuleAsset | null }) {
  const fit = fitOf(content.asset, content.durationMs);
  const fileMs = roundToStep(content.asset?.durationMs ?? 0);
  const what = content.contentType === "ADVERTISEMENT" ? "advert" : "filler";
  const name = content.asset?.filename ? `"${content.asset.filename}"` : `This ${what}`;
  if (fit.kind === "cut") {
    return `${name} is ${formatSeconds(fileMs)} long but has ${formatSeconds(content.durationMs)}: the last ${formatSeconds(
      roundToStep(fit.byMs),
    )} will be cut off.`;
  }
  if (fit.kind === "held") {
    return `${name} is only ${formatSeconds(fileMs)} long but has ${formatSeconds(
      content.durationMs,
    )}: its last frame will be held, silent, for ${formatSeconds(roundToStep(fit.byMs))}.`;
  }
  if (fit.kind === "unknown" && content.asset) {
    return `The length of ${name} is not known, so it may be cut off or held on its last frame.`;
  }
  return null;
}

export function sortContents<T extends Pick<RuleContent, "startTimeMs" | "orderInSlot">>(contents: T[]) {
  return contents.slice().sort((a, b) => a.startTimeMs - b.startTimeMs || a.orderInSlot - b.orderInSlot);
}

/** Lay items end to end in their order, from 0. */
export function withSequentialStartTimes<T extends Pick<RuleContent, "orderInSlot" | "durationMs" | "startTimeMs">>(
  contents: T[],
): T[] {
  let at = 0;
  return contents
    .slice()
    .sort((a, b) => a.orderInSlot - b.orderInSlot)
    .map((content, index) => {
      const next = { ...content, orderInSlot: index, startTimeMs: at };
      at += content.durationMs;
      return next;
    });
}

export type SlotArithmetic = {
  advertMs: number;
  fillerMs: number[];
  totalMs: number;
  /** Positive: time still to fill; negative: over the slot length. */
  remainingMs: number;
  advertCount: number;
};

export function slotArithmetic(contents: Pick<RuleContent, "durationMs" | "contentType">[]): SlotArithmetic {
  const adverts = contents.filter((content) => content.contentType === "ADVERTISEMENT");
  const fillers = contents.filter((content) => content.contentType === "FILLER");
  const totalMs = contents.reduce((sum, content) => sum + content.durationMs, 0);
  return {
    advertMs: adverts.reduce((sum, content) => sum + content.durationMs, 0),
    fillerMs: fillers.map((content) => content.durationMs),
    totalMs,
    remainingMs: SLOT_DURATION_MS - totalMs,
    advertCount: adverts.length,
  };
}

/** "advert 30 s + fillers 20 s + 5 s = 55 s, 5 s short of 60 s" */
export function describeArithmetic(arithmetic: SlotArithmetic) {
  const parts: string[] = [];
  if (arithmetic.advertCount > 0) parts.push(`advert ${formatSeconds(arithmetic.advertMs)}`);
  if (arithmetic.fillerMs.length > 0) {
    parts.push(
      `${arithmetic.fillerMs.length === 1 ? "filler" : "fillers"} ${arithmetic.fillerMs.map(formatSeconds).join(" + ")}`,
    );
  }
  const sum = parts.length ? `${parts.join(" + ")} = ${formatSeconds(arithmetic.totalMs)}` : "nothing yet";
  if (arithmetic.remainingMs === 0) return `${sum}, exactly ${formatSeconds(SLOT_DURATION_MS)}`;
  if (arithmetic.remainingMs > 0) return `${sum}, ${formatSeconds(arithmetic.remainingMs)} short of ${formatSeconds(SLOT_DURATION_MS)}`;
  return `${sum}, ${formatSeconds(-arithmetic.remainingMs)} over ${formatSeconds(SLOT_DURATION_MS)}`;
}

/**
 * Problems that stop a slot from being saved at all (a draft may be incomplete, but not
 * nonsensical). Returns plain-words messages; empty when it can be saved.
 */
export function draftSlotProblems(contents: RuleContent[]) {
  const problems: string[] = [];
  const adverts = contents.filter((content) => content.contentType === "ADVERTISEMENT");
  if (adverts.length > 1) problems.push("A slot can hold only one advert.");
  for (const content of contents) {
    if (!Number.isInteger(content.durationMs) || content.durationMs < MIN_ITEM_DURATION_MS) {
      problems.push(`Every item needs at least ${formatSeconds(MIN_ITEM_DURATION_MS)}.`);
      break;
    }
  }
  const sorted = sortContents(contents);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (current.startTimeMs < 0) {
      problems.push("An item starts before the slot.");
      break;
    }
    if (current.startTimeMs + current.durationMs > SLOT_DURATION_MS) {
      problems.push(
        `The items add up to more than ${formatSeconds(SLOT_DURATION_MS)} (${describeArithmetic(slotArithmetic(contents))}).`,
      );
      break;
    }
    if (next && current.startTimeMs + current.durationMs > next.startTimeMs) {
      problems.push("Two items overlap.");
      break;
    }
  }
  return problems;
}

/** Problems that stop a slot from being published; empty when it is ready. */
export function publishSlotProblems(contents: RuleContent[]) {
  const problems = draftSlotProblems(contents);
  if (problems.length) return problems;
  const arithmetic = slotArithmetic(contents);
  if (arithmetic.advertCount === 0) problems.push("Choose an advert.");
  if (arithmetic.remainingMs !== 0) {
    problems.push(`It must add up to exactly ${formatSeconds(SLOT_DURATION_MS)}: ${describeArithmetic(arithmetic)}.`);
  } else {
    // Exactly one minute with no overlaps: check there is no gap either (items end to end from 0).
    let at = 0;
    for (const content of sortContents(contents)) {
      if (content.startTimeMs !== at) {
        problems.push("There is a gap between items.");
        break;
      }
      at += content.durationMs;
    }
  }
  return problems;
}

export type FillerTemplateItem = { category: string; durationMs: number };

/**
 * Fit a filler template into the time left after the advert: items keep their lengths and the
 * last one absorbs the difference. Returns the durations, or a reason it cannot fit.
 */
export function fitTemplateDurations(template: FillerTemplateItem[], availableMs: number):
  | { ok: true; durations: number[]; adjustedLastByMs: number }
  | { ok: false; reason: string } {
  if (template.length === 0) {
    return { ok: false, reason: "The filler template is empty. Add fillers by hand, or set a template in Settings." };
  }
  if (availableMs < MIN_ITEM_DURATION_MS) {
    return { ok: false, reason: `The advert leaves only ${formatSeconds(Math.max(availableMs, 0))} for fillers.` };
  }
  const durations = template.map((item) => item.durationMs);
  const fixed = durations.slice(0, -1).reduce((sum, value) => sum + value, 0);
  const last = availableMs - fixed;
  if (last < MIN_ITEM_DURATION_MS) {
    return {
      ok: false,
      reason: `The template's first ${durations.length - 1 === 1 ? "filler takes" : `${durations.length - 1} fillers take`} ${formatSeconds(
        fixed,
      )}, more than the ${formatSeconds(availableMs)} this advert leaves.`,
    };
  }
  const adjustedLastByMs = last - durations[durations.length - 1];
  durations[durations.length - 1] = last;
  return { ok: true, durations, adjustedLastByMs };
}

/**
 * Settings check for a filler template: every item at least 1 s and the total short of a slot,
 * leaving room for an advert. An empty template is allowed (Auto-fill is then unavailable).
 */
export function fillerTemplateProblems(template: FillerTemplateItem[]) {
  const problems: string[] = [];
  if (template.some((item) => !Number.isInteger(item.durationMs) || item.durationMs < MIN_ITEM_DURATION_MS)) {
    problems.push(`Every template item needs at least ${formatSeconds(MIN_ITEM_DURATION_MS)}.`);
  }
  const total = template.reduce((sum, item) => sum + item.durationMs, 0);
  if (total > SLOT_DURATION_MS - MIN_ITEM_DURATION_MS) {
    problems.push(
      `The template adds up to ${formatSeconds(total)}, which leaves no room for an advert in a ${formatSeconds(SLOT_DURATION_MS)} slot.`,
    );
  }
  return problems;
}
