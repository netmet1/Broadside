import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useState,
} from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  type AppSettings,
  DEFAULT_BULK_CONFIRM_OVER,
  type HostLatency,
  MAX_BULK_CONFIRM_OVER,
  MIN_BULK_CONFIRM_OVER,
  networkProbe,
  recalibrateProbe,
  setAppSettings,
} from "@/lib/tauri/settings";

/** Performance + network-probe section. The input fields are seeded from the
 * loaded settings via `syncFromSettings` (called once in the page's load());
 * recalibrate writes the refreshed probe back through `setSettings`. */
export function usePerfSettings(
  setSettings: Dispatch<SetStateAction<AppSettings | null>>,
) {
  // Performance section (saved together via Save)
  const [maxSessions, setMaxSessions] = useState("");
  const [defaultTimeout, setDefaultTimeout] = useState("30");
  const [bulkConfirmOver, setBulkConfirmOver] = useState(
    String(DEFAULT_BULK_CONFIRM_OVER),
  );
  const [savingPerf, setSavingPerf] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);

  // Network probe
  const [probing, setProbing] = useState(false);
  const [latencies, setLatencies] = useState<HostLatency[] | null>(null);

  /** Seed the editable inputs from a freshly loaded settings object. Stable so
   * the page's load() callback can depend on it without re-running. */
  const syncFromSettings = useCallback((s: AppSettings) => {
    setMaxSessions(
      s.max_concurrent_sessions !== null
        ? String(s.max_concurrent_sessions)
        : "",
    );
    setDefaultTimeout(String(s.default_timeout_secs));
    setBulkConfirmOver(String(s.bulk_confirm_over));
  }, []);

  const parsedMaxSessions = (() => {
    if (maxSessions.trim() === "") return null; // follow suggestion
    const n = Number(maxSessions);
    return Number.isInteger(n) && n >= 1 && n <= 2048 ? n : undefined;
  })();
  const parsedTimeout = (() => {
    const n = Number(defaultTimeout);
    return Number.isInteger(n) && n >= 1 && n <= 3600 ? n : undefined;
  })();
  // No empty-means-default case, unlike max sessions: there is no probe to
  // follow here, so a blank box would have to mean the built-in 5, and a field
  // that reads as empty while behaving as 5 is worse than one that always shows
  // the number in force.
  const parsedBulkConfirmOver = (() => {
    const n = Number(bulkConfirmOver);
    return Number.isInteger(n) &&
      n >= MIN_BULK_CONFIRM_OVER &&
      n <= MAX_BULK_CONFIRM_OVER
      ? n
      : undefined;
  })();

  const savePerf = async () => {
    if (
      parsedMaxSessions === undefined ||
      parsedTimeout === undefined ||
      parsedBulkConfirmOver === undefined
    )
      return;
    setSavingPerf(true);
    try {
      await setAppSettings({
        max_concurrent_sessions: parsedMaxSessions,
        default_timeout_secs: parsedTimeout,
        bulk_confirm_over: parsedBulkConfirmOver,
      });
      // The Terminals page reads this from the settings object it keeps, so
      // write the saved value back rather than making it re-fetch: the guard
      // should move the moment Save returns, not on the next visit.
      setSettings((prev) =>
        prev ? { ...prev, bulk_confirm_over: parsedBulkConfirmOver } : prev,
      );
      toast.success("Settings saved");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingPerf(false);
    }
  };

  const recalibrate = async () => {
    setRecalibrating(true);
    try {
      const probe = await recalibrateProbe();
      setSettings((prev) => (prev ? { ...prev, local_probe: probe } : prev));
      toast.success(
        `Probe complete: suggests ${probe.suggested_max_sessions} sessions`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRecalibrating(false);
    }
  };

  const runNetworkProbe = async () => {
    setProbing(true);
    try {
      setLatencies(await networkProbe());
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProbing(false);
    }
  };

  return {
    maxSessions,
    setMaxSessions,
    defaultTimeout,
    setDefaultTimeout,
    bulkConfirmOver,
    setBulkConfirmOver,
    parsedBulkConfirmOver,
    savingPerf,
    recalibrating,
    probing,
    latencies,
    parsedMaxSessions,
    parsedTimeout,
    syncFromSettings,
    savePerf,
    recalibrate,
    runNetworkProbe,
  };
}
