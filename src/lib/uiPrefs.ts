import { createContext, useContext } from "react";

/** Appearance preferences applied app-wide: terminal font (xterm panes) and
 * the application root font size (scales all rem-based UI). */
export type UiPrefs = {
  terminalFontFamily: string;
  terminalFontSize: number;
  appFontSize: number;
};

export const DEFAULT_UI_PREFS: UiPrefs = {
  terminalFontFamily: "Consolas, 'Cascadia Mono', monospace",
  terminalFontSize: 13,
  appFontSize: 16,
};

export type UiPrefsContextValue = {
  prefs: UiPrefs;
  /** Updates the in-memory prefs (persistence is the caller's job). */
  apply: (prefs: UiPrefs) => void;
};

export const UiPrefsContext = createContext<UiPrefsContextValue | null>(null);

export function useUiPrefs(): UiPrefsContextValue {
  const ctx = useContext(UiPrefsContext);
  if (!ctx) throw new Error("useUiPrefs must be used inside UiPrefsProvider");
  return ctx;
}
