import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { HINT_BUDGET_PX, StatusContext } from "@/lib/status";
import { getAppSettings, setHelpHintsEnabled } from "@/lib/tauri/settings";

/** How long a hint may sit on an idle machine before the bar takes its line
 * back. A hint is cleared by the pointer leaving the control that raised it, so
 * the only way one lingers is nobody being there: the mouse was parked on a
 * button and the operator walked away. What the line shows instead (the window
 * size and the two font sizes) is the more useful thing to come back to.
 *
 * Short on purpose. This is not a reading-time budget, because a reader is
 * moving the mouse and the timer never fires for them; it is how long a hint
 * outlives the last sign of life in the room. Fifteen seconds felt like the bar
 * was stuck; 3.5 took the hint away before a still reader had finished it
 * (prompts111, smoke 70-s2), so 7. */
const HINT_IDLE_MS = 7_000;

/** How often the idle check runs. Fine enough that the timeout lands within a
 * quarter-second of what it says, and it only ticks while a hint is up. */
const HINT_IDLE_TICK_MS = 250;

export function StatusProvider({ children }: { children: ReactNode }) {
  const [pageStatus, setPageStatus] = useState<ReactNode>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [hintsEnabled, setEnabled] = useState(true);

  useEffect(() => {
    getAppSettings()
      .then((s) => setEnabled(s.help_hints_enabled))
      .catch(() => {
        // Hints stay on by default if settings can't load.
      });
  }, []);

  // Take the hint down once the machine has been still for HINT_IDLE_MS.
  //
  // Costed deliberately, because the obvious version of this is expensive: the
  // listeners exist only while a hint is showing (so the common case, no hint,
  // subscribes to nothing at all), activity writes a plain local rather than
  // state (so a mousemove never renders anything), and the timeout is one
  // interval instead of a timer torn down and rebuilt per event. Moving the
  // mouse across the app therefore costs one assignment per event, and only
  // while a hint is on screen.
  const hintShowing = hint !== null;
  useEffect(() => {
    if (!hintShowing) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    // Capture phase, because xterm stops keydown from bubbling out of a
    // terminal and typing into one is exactly the activity this looks for.
    const events = ["mousemove", "mousedown", "wheel", "keydown"] as const;
    for (const name of events) {
      window.addEventListener(name, bump, { passive: true, capture: true });
    }
    const timer = window.setInterval(() => {
      if (Date.now() - last >= HINT_IDLE_MS) setHint(null);
    }, HINT_IDLE_TICK_MS);
    return () => {
      for (const name of events) {
        window.removeEventListener(name, bump, { capture: true });
      }
      window.clearInterval(timer);
    };
  }, [hintShowing]);

  const showHint = useCallback((text: string) => {
    if (import.meta.env.DEV) warnIfTooWide(text);
    setHint(text);
  }, []);
  const clearHint = useCallback(() => setHint(null), []);
  const setHintsEnabled = useCallback(async (enabled: boolean) => {
    await setHelpHintsEnabled(enabled);
    setEnabled(enabled);
  }, []);

  const value = useMemo(
    () => ({
      pageStatus,
      setPageStatus,
      hint,
      showHint,
      clearHint,
      hintsEnabled,
      setHintsEnabled,
    }),
    [pageStatus, hint, showHint, clearHint, hintsEnabled, setHintsEnabled],
  );

  return (
    <StatusContext.Provider value={value}>{children}</StatusContext.Provider>
  );
}

/**
 * Development-only: complain about a hint that would be cut off with an
 * ellipsis at the app's smallest window.
 *
 * A hint the operator cannot finish reading is worse than a shorter one, and
 * there is no test that would catch it: the bar truncates silently, and it only
 * shows at 1024px with a long page status on the right. So the check runs where
 * the real font is loaded and can be measured -- once per distinct string, on
 * the first hover -- and says nothing in a release build.
 *
 * See HINT_BUDGET_PX in lib/status.ts for where the number comes from.
 */
const warned = new Set<string>();
let ctx: CanvasRenderingContext2D | null = null;
function warnIfTooWide(text: string) {
  if (warned.has(text)) return;
  warned.add(text);
  try {
    ctx ??= document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
    const px = Math.ceil(ctx.measureText(text).width);
    if (px > HINT_BUDGET_PX) {
      console.warn(
        `[hint] ${px}px, over the ${HINT_BUDGET_PX}px budget, so it will be cut off at a 1024px window. Shorten it:\n  ${text}`,
      );
    }
  } catch {
    // A measurement that cannot be made is not worth failing a render over.
  }
}
