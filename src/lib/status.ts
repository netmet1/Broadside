import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";

/** Shared state for the global bottom status bar: a per-page status line
 * (right side) and a transient help hint (left side) shown while the user
 * hovers or focuses an actionable control. */
export type StatusContextValue = {
  pageStatus: ReactNode;
  setPageStatus: (status: ReactNode) => void;
  hint: string | null;
  showHint: (text: string) => void;
  clearHint: () => void;
  hintsEnabled: boolean;
  /** Persists the toggle and updates the bar immediately. */
  setHintsEnabled: (enabled: boolean) => Promise<void>;
};

export const StatusContext = createContext<StatusContextValue | null>(null);

export function useStatus(): StatusContextValue {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error("useStatus must be used inside StatusProvider");
  return ctx;
}

/** Publish this page's status-bar text. Pass `active: false` for pages that
 * stay mounted while hidden (Terminals, Logs) so they don't overwrite the
 * visible page's status. */
export function usePageStatus(status: ReactNode, active = true) {
  const { setPageStatus } = useStatus();
  useEffect(() => {
    if (!active) return;
    setPageStatus(status);
    // All cleanups in a commit run before the next page's effect sets its
    // own status, so clearing here never stomps the incoming page.
    return () => setPageStatus(null);
  }, [status, active, setPageStatus]);
}

/** Returns a props factory: spread `hint("…")` onto any actionable element to
 * surface a help hint in the status bar on hover/focus. */
export function useHint() {
  const { showHint, clearHint } = useStatus();
  return useCallback(
    (text: string) => ({
      onMouseEnter: () => showHint(text),
      onMouseLeave: clearHint,
      onFocus: () => showHint(text),
      onBlur: clearHint,
    }),
    [showHint, clearHint],
  );
}
