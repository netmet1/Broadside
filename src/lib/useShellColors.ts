import { useEffect, useState } from "react";

import { loadShellColors, SHELL_COLORS_CHANGED } from "@/lib/terminalColors";

/** The current per-kind terminal colours, kept in step with Settings while both
 * pages are mounted.
 *
 * Two listeners, not one. `storage` is the browser's own event and it fires only
 * in *other* tabs, never in the one that wrote the value, so on its own a colour
 * change in Settings would not reach the Terminals page until a restart. The
 * custom event covers this window; `storage` is kept for the second Broadside
 * window a user may have open.
 *
 * Widened to a plain string key on the way out. Every caller looks a colour up
 * by a `LocalShell.kind`, which is typed `string` because a custom terminal
 * declares its own family, so keeping the narrow key here would only push a
 * cast into each of them. A kind with no colour reads as undefined, which every
 * caller already treats as "no colour". */
export function useShellColors(): Record<string, string | null | undefined> {
  const [colors, setColors] = useState(loadShellColors);
  useEffect(() => {
    const reload = () => setColors(loadShellColors());
    window.addEventListener(SHELL_COLORS_CHANGED, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(SHELL_COLORS_CHANGED, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);
  return colors;
}
