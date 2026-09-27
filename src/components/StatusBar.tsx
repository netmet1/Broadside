import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";

import { useActivityContext } from "@/lib/activity";
import {
  SESSION_PREFS_EVENT,
  describeIdle,
  loadSessionPrefs,
} from "@/lib/sessionPrefs";
import { useStatus } from "@/lib/status";
import { useUiPrefs } from "@/lib/uiPrefs";
import { useWindowSize } from "@/lib/useWindowSize";

/** Global non-scrolling bar pinned to the bottom of the window. Left side
 * shows the active help hint (when enabled), right side shows the current
 * page's status line (e.g. "Showing 4 hosts").
 *
 * With no hint to show, the left side is not left empty: it carries the window
 * size and the two font sizes, all three live. A hint takes the space back for
 * as long as it is up, because a hint is a thing the reader asked for by
 * pointing at a control and these three are only ever there to be glanced at.
 * They are the numbers you want while you are changing them, which is exactly
 * when a hint is not showing. An abandoned hint (pointer parked on a control,
 * nobody at the machine) times out in StatusProvider and gives the line back.
 *
 * A fourth item joins them while the session timeout is switched on: "Session
 * timeout 30m". Not a number anyone tunes by watching it, and that is not why
 * it is here. The timeout ships off and closes shells without asking once it
 * is on, so being on is worth a standing reminder, and it goes the moment the
 * timeout is switched off. Named in full rather than "Timeout", because the
 * broadcast timeout is also a timeout, and its default really is 30 seconds.
 *
 * Between those two and the page status sits the activity line: what the app is
 * still doing on a tab you have left. It has its own space rather than joining
 * the metrics, because a hint must not be able to hide the one thing on this
 * bar that is not there to be glanced at. */
export function StatusBar() {
  const { pageStatus, hint, hintsEnabled } = useStatus();
  const { activities } = useActivityContext();
  const { prefs } = useUiPrefs();
  const windowSize = useWindowSize();
  // Same subscription the Sessions settings use, so a change made there shows
  // here at once rather than on the next launch.
  const [idleSecs, setIdleSecs] = useState(() => loadSessionPrefs().idleSecs);
  useEffect(() => {
    const read = () => setIdleSecs(loadSessionPrefs().idleSecs);
    window.addEventListener(SESSION_PREFS_EVENT, read);
    return () => window.removeEventListener(SESSION_PREFS_EVENT, read);
  }, []);
  // Same truthiness the bar has always used, so a hint of "" still counts as
  // nothing to show rather than blanking the line.
  const showingHint = hintsEnabled && Boolean(hint);
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border/50 bg-statusbar px-3 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        {showingHint ? (
          hint
        ) : (
          // Tabular figures so the line does not jitter as the digits change
          // under a resize drag.
          <span className="tabular-nums">
            {windowSize} &middot; Terminal font {prefs.terminalFontSize}px
            &middot; App font {prefs.appFontSize}px
            {idleSecs !== null && (
              <> &middot; Session timeout {describeIdle(idleSecs)}</>
            )}
          </span>
        )}
      </span>
      {activities.length > 0 && (
        <span
          className="flex shrink-0 items-center gap-1.5 text-foreground/80"
          aria-live="polite"
        >
          <Loader2Icon className="h-3 w-3 animate-spin" />
          {activities.join(" · ")}
        </span>
      )}
      <span className="ml-auto shrink-0">{pageStatus}</span>
    </footer>
  );
}
