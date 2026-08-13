import { createContext, useContext } from "react";

/** Appearance preferences applied app-wide: terminal font (xterm panes), the
 * application root font size (scales all rem-based UI), and how much scrollback
 * a pane keeps.
 *
 * Scrollback is not appearance in the strict sense, but this is the one channel
 * that reaches every mounted xterm without remounting it, which is the whole
 * requirement: changing the setting must not throw away the buffers of the
 * panes that are already open. */
export type UiPrefs = {
  terminalFontFamily: string;
  terminalFontSize: number;
  appFontSize: number;
  /** Lines kept above the top of the screen, per pane. 0 keeps none. */
  terminalScrollback: number;
};

export const DEFAULT_UI_PREFS: UiPrefs = {
  terminalFontFamily: "Consolas, 'Cascadia Mono', monospace",
  terminalFontSize: 13,
  appFontSize: 16,
  // Mirrors DEFAULT_TERMINAL_SCROLLBACK in commands/settings.rs. Only ever seen
  // in the gap before the real settings load, or if that load fails.
  terminalScrollback: 5000,
};

/** The most a pane may be asked to keep. Mirrors MAX_TERMINAL_SCROLLBACK in
 * commands/settings.rs, which is the one that actually enforces it. */
export const MAX_TERMINAL_SCROLLBACK = 50000;

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
