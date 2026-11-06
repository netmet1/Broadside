import { useEffect } from "react";

import { isModKey } from "@/lib/platform";

/** ⌘A on a Mac, Ctrl+A on Windows, pressed outside anything that takes text,
 * would select every word in the window (sidebar, headings, status bar), as on
 * a web page. Nothing in Broadside wants that, so there the key does nothing.
 * Text boxes and the terminal (its input is a textarea) keep it, and so does
 * anything that handles the key itself: the SFTP Commander's panes select all
 * their files. */
export function useNoPageSelectAll() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModKey(e) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "a") return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
        return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
