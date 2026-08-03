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
 * when a hint is not showing. */
export function StatusBar() {
  const { pageStatus, hint, hintsEnabled } = useStatus();
  const { prefs } = useUiPrefs();
  const windowSize = useWindowSize();
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
          </span>
        )}
      </span>
      <span className="ml-auto shrink-0">{pageStatus}</span>
    </footer>
  );
}
