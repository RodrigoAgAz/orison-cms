"use client";

import { useState } from "react";

export function LoginForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const payload = {
      email: formData.get("email"),
      password: formData.get("password"),
    };

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error && body.error !== "Invalid request body" ? body.error : "Check the email and password.");
      setLoading(false);
      return;
    }

    // Back to the page that asked for sign-in (same site only).
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <div>
        <img alt="Orison" className="auth-logo" height={56} src="/m-app/windmill-gold.png" width={42} />
        <h1>Orison</h1>
        <p className="muted">Sign in to manage what plays on the cab screens.</p>
      </div>

      <label className="field">
        <span>Email</span>
        <input autoComplete="username" name="email" type="email" required placeholder="you@orisonscreens.com" />
      </label>

      <label className="field">
        <span>Password</span>
        <input autoComplete="current-password" name="password" type="password" required placeholder="••••••••" />
      </label>

      {error ? <div className="alert alert-danger">{error}</div> : null}

      <button className="button button-primary" disabled={loading} type="submit">
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

