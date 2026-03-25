"use client";

import { createContext, useContext, useMemo, useState } from "react";

type ToastTone = "success" | "error" | "info";

type ToastInput = {
  title: string;
  message?: string;
  tone?: ToastTone;
};

type ToastItem = ToastInput & {
  id: string;
  tone: ToastTone;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue>({
  toast: () => undefined,
});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast(input) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const item: ToastItem = {
          ...input,
          id,
          tone: input.tone ?? "info",
        };

        setItems((current) => [...current, item]);

        window.setTimeout(() => {
          setItems((current) => current.filter((toast) => toast.id !== id));
        }, 4200);
      },
    }),
    [],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" aria-live="polite" aria-atomic="true">
        {items.map((item) => (
          <div className={`toast toast-${item.tone}`} key={item.id}>
            <div className="toast-copy">
              <strong>{item.title}</strong>
              {item.message ? <span>{item.message}</span> : null}
            </div>
            <button
              aria-label="Dismiss notification"
              className="toast-close"
              onClick={() =>
                setItems((current) => current.filter((toast) => toast.id !== item.id))
              }
              type="button"
            >
              Close
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
