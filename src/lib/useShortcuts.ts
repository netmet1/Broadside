import { useEffect, useState } from "react";

import { getAppSettings } from "@/lib/tauri/settings";

/** Core + user shortcut commands for the ShortcutBar. Refetches whenever the
 * page becomes visible so edits made in Settings show up immediately. */
export function useShortcuts(active: boolean): string[] {
  const [shortcuts, setShortcuts] = useState<string[]>([]);
  useEffect(() => {
    if (!active) return;
    getAppSettings()
      .then((s) =>
        setShortcuts([
          ...s.core_shortcuts,
          ...s.user_shortcuts.map((u) => u.command),
        ]),
      )
      .catch(() => {
        // The dropdown just stays with what it had.
      });
  }, [active]);
  return shortcuts;
}
