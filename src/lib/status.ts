import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";

/** Shared state for the global bottom status bar: a per-page status line
 * (right side) and a transient help hint (left side) shown while the user
 * hovers or focuses an actionable control.
 *
 * A hint normally ends when the pointer leaves the control that raised it.
 * `StatusProvider` also takes one down after a few seconds with no mouse or
 * keyboard activity anywhere, so a pointer parked on a button while nobody is
 * at the machine does not hold the line forever. */
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

/**
 * How wide a hint may be, in pixels, at 12px in the app's own font.
 *
 * The status bar gives the hint one line and truncates it, so anything past
 * this is read by the operator as a sentence that stops mid-word. The number is
 * the width actually available at the smallest window the app can be dragged
 * to: 1024px, less the bar's own 24px of padding, less the 16px gap, less about
 * 262px for the longest page status on the right (Hosts, filtered, three-digit
 * counts). That leaves 722px; 700 is that with a little room for a longer
 * status than has been seen.
 *
 * A hint that will not fit belongs in the Help tab. Say what the control does
 * and stop -- and do not spend the line telling the reader to go and look
 * there, which costs the words that would have explained it.
 *
 * `StatusProvider` warns in the console, in development only, about any hint
 * that goes over.
 */
export const HINT_BUDGET_PX = 700;

/** Returns a props factory: spread `hint("…")` onto any actionable element to
 * surface a help hint in the status bar on hover/focus.
 *
 * Pointer events rather than mouse events, and that is the difference between a
 * greyed control that explains itself and one that says nothing. React will not
 * call `onMouseEnter` on a disabled `<button>`, `<input>`, `<select>` or
 * `<textarea>`: react-dom filters it out along with the click family, although
 * the browser does deliver the event. `onPointerEnter` is not on that list.
 * Measured with the app's own Button, Input and menu in Edge on 2026-09-13: the
 * browser raised both events on every disabled control, and only the mouse one
 * went missing. */
export function useHint() {
  const { showHint, clearHint } = useStatus();
  return useCallback(
    (text: string) => ({
      onPointerEnter: () => showHint(text),
      onPointerLeave: clearHint,
      onFocus: () => showHint(text),
      onBlur: clearHint,
    }),
    [showHint, clearHint],
  );
}
