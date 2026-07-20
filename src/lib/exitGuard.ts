// Guard against quitting the app while terminals are still connected. A UI-only
// preference (localStorage, like the tab-layout / theme prefs), read both by the
// window close handler in App and by the Settings toggle. Enabled by default:
// the key is absent until the user turns the guard OFF, and absence reads as on.
export const EXIT_GUARD_KEY = "exit-guard-connected";

/** Whether the "warn before quitting with connected terminals" guard is on.
 * Default true — only an explicit "0" disables it. Reads localStorage live so
 * the close handler always sees the current choice. */
export function isExitGuardEnabled(): boolean {
  return localStorage.getItem(EXIT_GUARD_KEY) !== "0";
}

export function setExitGuardEnabled(enabled: boolean): void {
  localStorage.setItem(EXIT_GUARD_KEY, enabled ? "1" : "0");
}
