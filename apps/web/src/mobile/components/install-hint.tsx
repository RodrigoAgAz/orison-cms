"use client";

import { useEffect, useState } from "react";

import { CloseIcon, PlusSquareIcon, ShareIcon } from "./icons";

const KEY = "orison.mobile.installHintDismissed";

function isStandalone() {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

/** Shown in iPhone Safari (not when opened from the Home Screen) until dismissed. */
export function InstallHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const ua = window.navigator.userAgent;
    const isIos = /iPhone|iPad|iPod/.test(ua);
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(KEY) === "1";
    } catch {
      dismissed = false;
    }
    setShow(isIos && !isStandalone() && !dismissed);
  }, []);

  if (!show) return null;
  return (
    <aside className="m-install" aria-label="Add Orison to your Home Screen" data-testid="install-hint">
      <div className="m-install-body">
        <strong>Add Orison to your Home Screen</strong>
        <p>
          Tap <ShareIcon size={17} className="m-inline-icon" title="Share" /> <b>Share</b> at the bottom of Safari, then{" "}
          <PlusSquareIcon size={17} className="m-inline-icon" title="Add to Home Screen" /> <b>Add to Home Screen</b>. It
          will open like an app, full screen.
        </p>
      </div>
      <button
        type="button"
        className="m-iconbtn"
        aria-label="Hide this tip"
        onClick={() => {
          setShow(false);
          try {
            localStorage.setItem(KEY, "1");
          } catch {
            // ignore
          }
        }}
      >
        <CloseIcon size={18} />
      </button>
    </aside>
  );
}
