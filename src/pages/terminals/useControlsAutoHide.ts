import { useEffect, useState } from "react";

import { SESSION_PREFS_EVENT, controlsAutoHide } from "@/lib/sessionPrefs";

/** The Settings -> Sessions choice to keep the Terminals controls row tucked
 * away until the pointer reaches it, kept current while this page stays
 * mounted: a change in Settings reaches it through the session-prefs event,
 * the same way it reaches the open terminals. */
export function useControlsAutoHide(): boolean {
  const [on, setOn] = useState(controlsAutoHide);
  useEffect(() => {
    const read = () => setOn(controlsAutoHide());
    window.addEventListener(SESSION_PREFS_EVENT, read);
    return () => window.removeEventListener(SESSION_PREFS_EVENT, read);
  }, []);
  return on;
}
