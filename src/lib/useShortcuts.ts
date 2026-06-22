import { useEffect, useState } from "react";

import { getAppSettings, type ShortcutScope } from "@/lib/tauri/settings";

/** A shortcut as the dropdown needs it: the command plus the scope that decides
 * which terminals it can run in, and an optional friendly label to show in
 * place of the raw command (user shortcuts only; core shortcuts have none). */
export type ScopedShortcut = {
  command: string;
  scope: ShortcutScope;
  label?: string | null;
};

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
            label: u.label,
          })),
        ]),
      )
      .catch(() => {
        // The dropdown just stays with what it had.
      });
  }, [active]);
  return shortcuts;
}
