"use client";

import { useEffect } from "react";

import clsx from "clsx";

type Props = {
  children: React.ReactNode;
  title?: string;
  eyebrow?: string;
  onClose: () => void;
  className?: string;
};

export function Modal({ children, title, eyebrow, onClose, className }: Props) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
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
    </div>
  );
}
