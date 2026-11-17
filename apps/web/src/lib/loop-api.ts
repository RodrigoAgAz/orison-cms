// Request parsing and error mapping for the loops, assets, settings and device-group routes:
// validation failures say which field is wrong ("Name must be at least 2 characters"), and the
// rule errors of the loop libraries become 400/409 answers with their own message.

import { ZodError, type ZodTypeAny, type output } from "zod";

import { StaleEditError, LoopRuleError } from "./loops";
import { ApiError } from "./http";
import { PlanError } from "./loop-plan";
import { PublishRefused } from "./loop-publish";

const fieldLabels: Record<string, string> = {
  name: "Name",
  targetGroupId: "Target",
  contents: "Slot contents",
  durationMs: "Duration",
  defaultFillerTemplate: "Filler template",
  syncIntervalSeconds: "Sync interval",
  heartbeatIntervalSeconds: "Heartbeat interval",
  safetyMessageDurationSeconds: "Safety message duration",
  loopFrameWidth: "Screen width",
  loopFrameHeight: "Screen height",
  description: "Description",
  category: "Category",
};

/** One readable sentence per problem, naming the field. */
export function zodMessages(error: ZodError) {
  return error.issues.map((issue) => {
    const field = [...issue.path].reverse().find((part) => typeof part === "string") as string | undefined;
    const label = field ? fieldLabels[field] ?? field : null;
    let text = issue.message;
    if (issue.code === "too_small" && issue.type === "string") text = `must be at least ${issue.minimum} characters`;
    if (issue.code === "too_big" && issue.type === "string") text = `must be at most ${issue.maximum} characters`;
    if (issue.code === "too_small" && issue.type === "number") text = `must be at least ${issue.minimum}`;
    if (issue.code === "too_big" && issue.type === "number") text = `must be at most ${issue.maximum}`;
    if (issue.code === "invalid_type") text = issue.received === "undefined" ? "is required" : `must be a ${issue.expected}`;
    if (issue.code === "custom" || !label) return text.endsWith(".") ? text : `${text}.`;
    return `${label} ${text.replace(/^String /, "").replace(/^Number /, "")}.`;
  });
}

export async function parseBody<S extends ZodTypeAny>(request: Request, schema: S): Promise<output<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError("The request was not valid JSON.", 400);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const messages = zodMessages(result.error);
    throw new ApiError(messages.join(" "), 400, { fields: result.error.flatten().fieldErrors, messages });
  }
  return result.data;
}

/** Map library errors to API errors (anything else stays a 500 with the detail in the log). */
export function toApiError(error: unknown) {
  if (error instanceof ApiError) return error;
  if (error instanceof StaleEditError) return new ApiError(error.message, 409, { stale: true });
  if (error instanceof PublishRefused) return new ApiError(error.message, error.status);
  if (error instanceof LoopRuleError || error instanceof PlanError) return new ApiError(error.message, 400);
  return error;
}
