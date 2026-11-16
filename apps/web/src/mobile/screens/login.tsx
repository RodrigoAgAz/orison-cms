"use client";

import { useEffect, useState } from "react";

import { BrandMark } from "../components/icons";
import { Notice, Spinner } from "../components/ui";

/**
 * `signInRequired`: PHONE_APP_REQUIRE_SIGN_IN is set, so the whole phone app needs sign-in.
 * Otherwise (the default) signing in is only for managing the team and changing a password.
 */
export function LoginScreen({ next, signInRequired }: { next: string; signInRequired: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The button stays disabled until the page is interactive, so a quick tap can't submit the
  // form natively (which would put the password in the address bar).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email") ?? "").trim(), password: form.get("password") }),
      });
      if (!response.ok) {
        setError(
          response.status === 401 || response.status === 400
            ? "That email and password don’t match. Check them and try again."
            : "We couldn’t sign you in just now. Please try again in a moment.",
        );
        setBusy(false);
        return;
      }
      window.location.replace(next);
    } catch {
      setError("No connection. Check your signal and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="m-app m-login">
      <main className="m-login-main">
        <div className="m-login-brand">
          <BrandMark size={84} />
          <h1>Orison Screens</h1>
          <p>
            {signInRequired
              ? "Sign in to see and change what plays in your cabs."
              : "Sign in to manage the team or change your password. You don’t need to sign in to use the app."}
          </p>
        </div>
        <form className="m-form m-card" onSubmit={onSubmit} method="post" action="/m/login">
          <label className="m-field">
            <span>Email</span>
            <input
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </label>
          <label className="m-field">
            <span>Password</span>
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error ? (
            <Notice tone="danger" testId="login-error">
              {error}
            </Notice>
          ) : null}
          <button type="submit" className="m-btn m-btn-primary m-btn-block" disabled={busy || !hydrated} data-testid="login-submit">
            {busy ? <Spinner size={18} /> : null}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="m-login-foot">
          Forgotten your password? Ask an admin on your team to reset it.
          <br />
          {signInRequired ? (
            <a href="/?view=desktop">Use the desktop site</a>
          ) : (
            <a href="/m" data-testid="login-skip">
              Back to the app without signing in
            </a>
          )}
        </p>
      </main>
    </div>
  );
}
