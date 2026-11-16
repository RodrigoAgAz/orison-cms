"use client";

import { useEffect, useState } from "react";

import { BrandMark } from "../components/icons";
import { Notice, Spinner } from "../components/ui";

export function LoginScreen({ next }: { next: string }) {
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
          <BrandMark size={64} />
          <h1>Orison Screens</h1>
          <p>Sign in to see and change what plays in your cabs.</p>
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
          <a href="/?view=desktop">Use the desktop site</a>
        </p>
      </main>
    </div>
  );
}
