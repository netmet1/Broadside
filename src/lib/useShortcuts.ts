import { useEffect, useState } from "react";

import { getAppSettings, type ShortcutScope } from "@/lib/tauri/settings";

/** A shortcut as the dropdown needs it: the command plus the scope that decides
 * which terminals it can run in. */
export type ScopedShortcut = { command: string; scope: ShortcutScope };

/** Core + user shortcut commands for the ShortcutBar. Refetches whenever the
 * page becomes visible so edits made in Settings show up immediately. */
export function useShortcuts(active: boolean): ScopedShortcut[] {
  const [shortcuts, setShortcuts] = useState<ScopedShortcut[]>([]);
  useEffect(() => {
    if (!active) return;
    getAppSettings()
      .then((s) =>
        setShortcuts([
          ...s.core_shortcuts.map((c) => ({
            command: c.command,
            scope: c.scope,
          })),
          ...s.user_shortcuts.map((u) => ({
            command: u.command,
            scope: u.scope,
          })),
        ]),
      )
      .catch(() => {
        // The dropdown just stays with what it had.
      });
  }, [active]);
  return shortcuts;
}
