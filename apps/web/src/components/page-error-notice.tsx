"use client";

import { useEffect, useRef } from "react";

import { useToast } from "@/components/toast-provider";

type Props = {
  message: string | null;
  title?: string;
};

export function PageErrorNotice({ message, title = "Data unavailable" }: Props) {
  const { toast } = useToast();
  const hasShownRef = useRef(false);

  useEffect(() => {
    if (!message || hasShownRef.current) {
      return;
    }

    hasShownRef.current = true;
    toast({
      title,
      message,
      tone: "error",
    });
  }, [message, title, toast]);

  if (!message) {
    return null;
  }

  return <div className="alert alert-danger">{message}</div>;
}
