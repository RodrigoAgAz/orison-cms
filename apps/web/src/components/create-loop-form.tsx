"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { useToast } from "@/components/toast-provider";

export function CreateLoopForm() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "");

    const response = await fetch("/api/loops", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      const message = body?.error ?? "Unable to create loop";
      setError(message);
      toast({
        title: "Loop creation failed",
        message,
        tone: "error",
      });
      setLoading(false);
      return;
    }

    const body = (await response.json()) as { id: string };
    toast({
      title: "Loop created",
      message: `${name} is ready in the builder.`,
      tone: "success",
    });
    router.push(`/loops/${body.id}`);
  }

  return (
    <form className="inline-form" onSubmit={handleSubmit}>
      <input name="name" placeholder="Week 12 - 2026" required />
      <button className="button button-primary" disabled={loading} type="submit">
        {loading ? (
          <span className="button-inline">
            <span aria-hidden className="button-spinner" />
            Creating loop
          </span>
        ) : (
          "Create Loop"
        )}
      </button>
      {error ? <span className="error-text">{error}</span> : null}
    </form>
  );
}
