// Fetch wrapper for the mobile app. Errors carry the server's human message. A 401 sends the user
// to sign in and returns them to the same screen afterwards. With the phone app open (the server
// default) the app's own routes never answer 401; only the team and password screens need a
// signed-in user, and they check `useSessionUser().signedIn` before calling the API.
//
// Every request is bounded: a request that has not answered within its time limit is abandoned
// (the browser cancels it) and fails with `timedOut`. A phone on a weak signal can otherwise wait
// for minutes on a request that will never answer.

/** How long a read may take before we give up and try again later. */
export const READ_TIMEOUT_MS = 20_000;
/** How long a change may take. After this we can't tell whether the server applied it. */
export const WRITE_TIMEOUT_MS = 30_000;

export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
    public network = false,
    /**
     * A change (POST/PUT/PATCH/DELETE) left without an answer: the request may have reached the
     * server and been applied. Callers must not report it as failed; they say so and check.
     */
    public uncertain = false,
    public timedOut = false,
  ) {
    super(message);
  }
}

let redirectingToLogin = false;

export function loginUrl(next?: string) {
  const target = next ?? (typeof window === "undefined" ? "/m" : `${window.location.pathname}${window.location.search}`);
  return `/m/login?next=${encodeURIComponent(target)}`;
}

export function sendToLogin() {
  if (redirectingToLogin || typeof window === "undefined") return;
  redirectingToLogin = true;
  window.location.replace(loginUrl());
}

export const NO_ANSWER_READ = "The server didn’t answer in time. We’ll keep trying.";
export const NO_CONNECTION = "No connection. Check your signal and try again.";
/** Shown when a change got no answer. The caller usually adds how to check. */
export const NO_ANSWER_WRITE =
  "We didn’t hear back from the server, so we can’t tell whether this went through. It may have worked.";

function isWrite(method: string | undefined) {
  return Boolean(method && !["GET", "HEAD"].includes(method.toUpperCase()));
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown; timeoutMs?: number }): Promise<T> {
  const { json, timeoutMs, ...rest } = init ?? {};
  const write = isWrite(rest.method);
  const limit = timeoutMs ?? (write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
  if (write && typeof navigator !== "undefined" && navigator.onLine === false) {
    // Known offline before sending: nothing reached the server.
    throw new ApiFailure("No connection, so nothing was sent. Try again when you have a signal.", 0, undefined, true);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limit);
  const outer = rest.signal;
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort);

  try {
    let response: Response;
    try {
      response = await fetch(path, {
        cache: "no-store",
        credentials: "same-origin",
        ...rest,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(rest.headers ?? {}),
        },
        body: json !== undefined ? JSON.stringify(json) : rest.body,
      });
    } catch {
      if (outer?.aborted && !timedOut) throw new ApiFailure("Cancelled.", 0, undefined, false);
      if (write) throw new ApiFailure(NO_ANSWER_WRITE, 0, undefined, true, true, timedOut);
      throw new ApiFailure(timedOut ? NO_ANSWER_READ : NO_CONNECTION, 0, undefined, true, false, timedOut);
    }

    if (response.status === 401) {
      sendToLogin();
      throw new ApiFailure("Your session has ended. Please sign in again.", 401);
    }

    // The body can stall too; the same timer covers it.
    let body: (T & { error?: string; details?: unknown }) | null;
    try {
      body = (await response.json()) as T & { error?: string; details?: unknown };
    } catch {
      if (timedOut) {
        if (write) throw new ApiFailure(NO_ANSWER_WRITE, 0, undefined, true, true, true);
        throw new ApiFailure(NO_ANSWER_READ, 0, undefined, true, false, true);
      }
      body = null;
    }
    if (!response.ok) {
      // A gateway timeout or proxy error in front of the app: the change may still have been applied.
      if (write && [502, 503, 504].includes(response.status)) {
        throw new ApiFailure(NO_ANSWER_WRITE, response.status, undefined, false, true);
      }
      throw new ApiFailure(friendlyError(body?.error, response.status), response.status, body?.details);
    }
    return body as T;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

function friendlyError(message: string | undefined, status: number) {
  if (message && message !== "Internal server error" && message !== "Invalid request body") {
    return message;
  }
  if (status >= 500) return "Something went wrong on our side. Please try again in a moment.";
  if (status === 404) return "That no longer exists. It may have been removed.";
  return message === "Invalid request body" ? "Some details aren't right. Check them and try again." : "That didn't work. Please try again.";
}
