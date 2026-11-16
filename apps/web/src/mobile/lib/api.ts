// Fetch wrapper for the mobile app. Errors carry the server's human message. A 401 sends the user
// to sign in and returns them to the same screen afterwards. With the phone app open (the server
// default) the app's own routes never answer 401; only the team and password screens need a
// signed-in user, and they check `useSessionUser().signedIn` before calling the API.

export class ApiFailure extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
    public network = false,
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

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...rest,
      headers: {
        Accept: "application/json",
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers ?? {}),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiFailure("No connection. Check your signal and try again.", 0, undefined, true);
  }

  if (response.status === 401) {
    sendToLogin();
    throw new ApiFailure("Your session has ended. Please sign in again.", 401);
  }

  const body = (await response.json().catch(() => null)) as (T & { error?: string; details?: unknown }) | null;
  if (!response.ok) {
    throw new ApiFailure(friendlyError(body?.error, response.status), response.status, body?.details);
  }
  return body as T;
}

function friendlyError(message: string | undefined, status: number) {
  if (message && message !== "Internal server error" && message !== "Invalid request body") {
    return message;
  }
  if (status >= 500) return "Something went wrong on our side. Please try again in a moment.";
  if (status === 404) return "That no longer exists. It may have been removed.";
  return message === "Invalid request body" ? "Some details aren't right. Check them and try again." : "That didn't work. Please try again.";
}
