"use client";

// In-app history depth. Installed web apps have no browser back button, so inner screens show
// their own Back button: it goes back through in-app history when there is some, and otherwise
// (opened from a link or after a reload) to the screen's parent.

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";

const NavDepthContext = createContext(1);

export function NavDepthProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const stack = useRef<string[]>([]);
  const [depth, setDepth] = useState(1);

  useEffect(() => {
    const current = stack.current;
    if (current.length === 0) {
      current.push(pathname);
    } else if (current[current.length - 2] === pathname) {
      current.pop();
    } else if (current[current.length - 1] !== pathname) {
      current.push(pathname);
    }
    setDepth(current.length);
  }, [pathname]);

  return <NavDepthContext.Provider value={depth}>{children}</NavDepthContext.Provider>;
}

export function useNavDepth() {
  return useContext(NavDepthContext);
}
