import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  DEFAULT_UI_PREFS,
  UiPrefsContext,
  type UiPrefs,
} from "@/lib/uiPrefs";
import { getAppSettings } from "@/lib/tauri/settings";

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<UiPrefs>(DEFAULT_UI_PREFS);

  useEffect(() => {
    getAppSettings()
      .then((s) =>
        setPrefs({
          terminalFontFamily: s.terminal_font_family,
          terminalFontSize: s.terminal_font_size,
          appFontSize: s.app_font_size,
        }),
      )
      .catch(() => {
        // Defaults are fine if settings can't load.
      });
  }, []);

  // The app font size scales every rem-based Tailwind size in one move.
  useEffect(() => {
    document.documentElement.style.fontSize = `${prefs.appFontSize}px`;
  }, [prefs.appFontSize]);

  const value = useMemo(() => ({ prefs, apply: setPrefs }), [prefs]);

  return (
    <UiPrefsContext.Provider value={value}>{children}</UiPrefsContext.Provider>
  );
}
