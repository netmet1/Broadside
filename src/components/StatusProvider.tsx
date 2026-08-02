import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { HINT_BUDGET_PX, StatusContext } from "@/lib/status";
import { getAppSettings, setHelpHintsEnabled } from "@/lib/tauri/settings";

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
