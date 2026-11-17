"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import clsx from "clsx";

type Props = {
  children: React.ReactNode;
  title?: string;
  eyebrow?: string;
  onClose: () => void;
  className?: string;
};

export function Modal({ children, title, eyebrow, onClose, className }: Props) {
  // Rendered into <body>: the page-enter animation leaves a transform on the page wrapper, which
  // would otherwise make this fixed overlay position itself against the whole (tall) page.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={clsx("modal-panel", className)}
        onClick={(event) => event.stopPropagation()}
      >
        {title || eyebrow ? (
          <div className="card-header">
            <div>
              {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
              {title ? <h2>{title}</h2> : null}
            </div>
            <button className="button button-secondary" onClick={onClose} type="button">
              Close
            </button>
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  );
}
