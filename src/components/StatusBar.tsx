import { useStatus } from "@/lib/status";

/** Global non-scrolling bar pinned to the bottom of the window. Left side
 * shows the active help hint (when enabled), right side shows the current
 * page's status line (e.g. "Showing 4 hosts"). */
export function StatusBar() {
  const { pageStatus, hint, hintsEnabled } = useStatus();
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border/50 bg-statusbar px-3 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        {hintsEnabled && hint ? hint : ""}
      </span>
      <span className="ml-auto shrink-0">{pageStatus}</span>
    </footer>
  );
}
