import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import { loadHiddenCols, saveHiddenCols } from "@/lib/hostColumns";
import {
  reconcileDisabledShells,
  saveDisabledShells,
} from "@/lib/localShellPrefs";
import { type LocalShell, listLocalShells } from "@/lib/tauri/local";
import { type AppSettings, setUiSettings } from "@/lib/tauri/settings";
import { useUiPrefs } from "@/lib/uiPrefs";

/** Appearance section: terminal/app fonts, host-table column visibility and the
 * local-shell launcher list. Font inputs are seeded from the loaded settings
 * via `syncFromSettings` (called once in the page's load()). */
export function useAppearance() {
  const { prefs, apply: applyUiPrefs } = useUiPrefs();

  // Host-table column visibility (Appearance). Read by the Hosts tab on mount;
  // saved immediately on toggle.
  const [hiddenCols, setHiddenCols] = useState(loadHiddenCols);
  const toggleColumn = (id: string, visible: boolean) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      saveHiddenCols(next);
      return next;
    });
  };

  // Local-shell launcher visibility (Appearance). The detected shells plus the
  // user's hide list (stored by id); the Terminals "+" menu reads the same list.
  const [shells, setShells] = useState<LocalShell[]>([]);
  const [disabledShells, setDisabledShells] = useState<Set<string>>(new Set());
  useEffect(() => {
    listLocalShells()
      .then((s) => {
        setShells(s);
        setDisabledShells(reconcileDisabledShells(s.map((x) => x.id)));
      })
      .catch(() => {
        // Non-fatal: the section just shows "no local shells detected".
      });
  }, []);
  const toggleShell = (id: string, enabled: boolean) => {
    setDisabledShells((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(id);
      else next.add(id);
      saveDisabledShells(next);
      return next;
    });
  };

  // Fonts
  const [termFontFamily, setTermFontFamily] = useState("");
  const [termFontSize, setTermFontSize] = useState("13");
  const [appFontSize, setAppFontSize] = useState("16");
  const [savingUi, setSavingUi] = useState(false);

  /** Seed the editable font inputs from a freshly loaded settings object. */
  const syncFromSettings = useCallback((s: AppSettings) => {
    setTermFontFamily(s.terminal_font_family);
    setTermFontSize(String(s.terminal_font_size));
    setAppFontSize(String(s.app_font_size));
  }, []);

  const parsedTermFontSize = (() => {
    const n = Number(termFontSize);
    return Number.isInteger(n) && n >= 8 && n <= 32 ? n : undefined;
  })();
  const parsedAppFontSize = (() => {
    const n = Number(appFontSize);
    return Number.isInteger(n) && n >= 12 && n <= 20 ? n : undefined;
  })();

  const saveAppearance = async () => {
    if (parsedTermFontSize === undefined || parsedAppFontSize === undefined) {
      return;
    }
    setSavingUi(true);
    try {
      await setUiSettings({
        terminal_font_family: termFontFamily.trim(),
        terminal_font_size: parsedTermFontSize,
        app_font_size: parsedAppFontSize,
      });
      applyUiPrefs({
        terminalFontFamily: termFontFamily.trim() || prefs.terminalFontFamily,
        terminalFontSize: parsedTermFontSize,
        appFontSize: parsedAppFontSize,
      });
      toast.success("Appearance saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingUi(false);
    }
  };

  return {
    hiddenCols,
    toggleColumn,
    shells,
    disabledShells,
    toggleShell,
    termFontFamily,
    setTermFontFamily,
    termFontSize,
    setTermFontSize,
    appFontSize,
    setAppFontSize,
    savingUi,
    parsedTermFontSize,
    parsedAppFontSize,
    syncFromSettings,
    saveAppearance,
  };
}
