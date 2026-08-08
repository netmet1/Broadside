import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import { loadHiddenCols, saveHiddenCols } from "@/lib/hostColumns";
import {
  GENERIC_MONOSPACE,
  detectMonospaceFonts,
  resolveStoredFamily,
  storedFontValue,
} from "@/lib/monospaceFonts";
import {
  reconcileDisabledShells,
  saveDisabledShells,
} from "@/lib/localShellPrefs";
import { type LocalShell, listLocalShells } from "@/lib/tauri/local";
import { type AppSettings, setUiSettings } from "@/lib/tauri/settings";
import {
  loadTerminalFontStrict,
  saveTerminalFontStrict,
} from "@/lib/terminalZoom";
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

  // The monospace fonts this machine can actually render, measured once when
  // the page mounts (see lib/monospaceFonts). Once per mount is enough and no
  // more would help: the webview caches the system font list for the life of
  // the process, so a font installed while Broadside is running cannot be
  // measured until it restarts, whatever we do here.
  const [installedFonts] = useState(detectMonospaceFonts);

  // A stored font-family list whose every name is missing from this machine.
  // Kept as an option of its own rather than discarded, because a dropdown that
  // quietly drops a setting it does not recognise is a dropdown that changes
  // your terminal's appearance for you the first time you open Settings.
  const [unknownFont, setUnknownFont] = useState<string | null>(null);

  // The selected family, NOT a CSS list. `unknownFont`, when there is one, is
  // the exception and is carried verbatim.
  const [termFontFamily, setTermFontFamily] = useState(GENERIC_MONOSPACE);
  const [termFontSize, setTermFontSize] = useState("13");
  const [appFontSize, setAppFontSize] = useState("16");
  const [savingUi, setSavingUi] = useState(false);

  /** What the dropdown offers: the detected fonts, plus an unrecognised stored
   * value if there is one, which sorts last because it is the one entry that is
   * not known to work. */
  const fontOptions = useMemo(
    () => (unknownFont === null ? installedFonts : [...installedFonts, unknownFont]),
    [installedFonts, unknownFont],
  );

  /** Seed the editable font inputs from a freshly loaded settings object. */
  const syncFromSettings = useCallback(
    (s: AppSettings) => {
      // A stored value has always been a fallback chain, and has always
      // resolved to exactly one face: the first name in it that is installed.
      // Selecting that name shows the operator the font they have been looking
      // at, rather than appearing to change their setting on upgrade.
      const resolved = resolveStoredFamily(s.terminal_font_family, installedFonts);
      if (resolved === null && s.terminal_font_family.trim()) {
        setUnknownFont(s.terminal_font_family);
        setTermFontFamily(s.terminal_font_family);
      } else {
        setUnknownFont(null);
        setTermFontFamily(resolved ?? GENERIC_MONOSPACE);
      }
      setTermFontSize(String(s.terminal_font_size));
      setAppFontSize(String(s.app_font_size));
    },
    [installedFonts],
  );

  // Ctrl + wheel over a terminal writes the size straight into the prefs (see
  // lib/terminalZoom), and Settings stays mounted, so without this the field
  // would go on showing the old number: the same complaint the grid had when a
  // drag changed a tile size behind its back. Typing in the box does not move
  // `prefs`, so this cannot fight the reader mid-edit.
  const [prevTermFontSize, setPrevTermFontSize] = useState(prefs.terminalFontSize);
  if (prevTermFontSize !== prefs.terminalFontSize) {
    setPrevTermFontSize(prefs.terminalFontSize);
    setTermFontSize(String(prefs.terminalFontSize));
  }

  // Whether the field above is the last word. Off by default: the wheel works
  // out of the box and this is how it is turned off.
  const [termFontStrict, setTermFontStrict] = useState(loadTerminalFontStrict);
  const toggleTermFontStrict = (v: boolean) => {
    setTermFontStrict(v);
    saveTerminalFontStrict(v);
  };

  /** How a family is stored: a detected name gets the generic behind it, and an
   * unrecognised stored value is written back exactly as it came, so choosing
   * something else and changing your mind cannot mangle it. */
  const storedValueFor = useCallback(
    (family: string) => (family === unknownFont ? family : storedFontValue(family)),
    [unknownFont],
  );

  /** The family applies as it is picked, with no Save. Every value the dropdown
   * can produce has been measured and is a legal font, so unlike the size boxes
   * below it there is no half-typed state to protect against; and a font you
   * cannot see until you commit is a font you are guessing at, which is the
   * same argument the tab-colour swatches already make.
   *
   * The sizes deliberately do not ride along. They are free text and may be
   * mid-edit or outright invalid at this moment, so this writes the sizes that
   * are currently in force rather than whatever is sitting in the boxes:
   * picking a font must not commit a number nobody has finished typing.
   *
   * The dropdown moves first and rolls back if the write fails, so a font that
   * did not save cannot be left looking as though it did. */
  const chooseFontFamily = async (family: string) => {
    const previous = termFontFamily;
    if (family === previous) return;
    setTermFontFamily(family);
    const fontValue = storedValueFor(family);
    try {
      await setUiSettings({
        terminal_font_family: fontValue,
        terminal_font_size: prefs.terminalFontSize,
        app_font_size: prefs.appFontSize,
      });
      applyUiPrefs({ ...prefs, terminalFontFamily: fontValue });
    } catch (e) {
      setTermFontFamily(previous);
      toast.error(errorMessage(e));
    }
  };

  const parsedTermFontSize = (() => {
    const n = Number(termFontSize);
    return Number.isInteger(n) && n >= 8 && n <= 32 ? n : undefined;
  })();
  const parsedAppFontSize = (() => {
    const n = Number(appFontSize);
    return Number.isInteger(n) && n >= 12 && n <= 20 ? n : undefined;
  })();

  /** The two size boxes, and only those. The family is already saved by the
   * time this runs (see chooseFontFamily), and is re-sent unchanged because the
   * backend takes the three together. */
  const saveFontSizes = async () => {
    if (parsedTermFontSize === undefined || parsedAppFontSize === undefined) {
      return;
    }
    setSavingUi(true);
    const fontValue = storedValueFor(termFontFamily);
    try {
      await setUiSettings({
        terminal_font_family: fontValue,
        terminal_font_size: parsedTermFontSize,
        app_font_size: parsedAppFontSize,
      });
      applyUiPrefs({
        terminalFontFamily: fontValue,
        terminalFontSize: parsedTermFontSize,
        appFontSize: parsedAppFontSize,
      });
      toast.success("Font sizes saved");
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
    chooseFontFamily,
    fontOptions,
    unknownFont,
    termFontSize,
    setTermFontSize,
    termFontStrict,
    toggleTermFontStrict,
    appFontSize,
    setAppFontSize,
    savingUi,
    parsedTermFontSize,
    parsedAppFontSize,
    syncFromSettings,
    saveFontSizes,
  };
}
