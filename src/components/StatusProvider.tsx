import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { StatusContext } from "@/lib/status";
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

  const showHint = useCallback((text: string) => setHint(text), []);
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
