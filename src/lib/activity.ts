import { createContext, useContext, useEffect } from "react";

/**
 * Shared state for the status bar's "still working" indicator: the short list
 * of things the app has under way that outlive the tab they were started on.
 *
 * The point of it is the tab you are *not* looking at. A file transfer started
 * in SFTP keeps running while you go and read a log, and the toast saying it
 * finished arrives wherever you happen to be; between those two moments there
 * was nothing anywhere on screen saying anything was happening at all. This is
 * the line that says so.
 *
 * Entries are keyed, so a page replaces its own line without knowing about
 * anyone else's, and are strictly for long-running work. Anything that finishes
 * in the time it takes to notice it does not belong here.
 */
export type ActivityContextValue = {
  /** What is under way, in the order it was registered. */
  activities: string[];
  /** Publishes (or, with a null label, withdraws) one keyed entry. */
  setActivity: (id: string, label: string | null) => void;
};

export const ActivityContext = createContext<ActivityContextValue | null>(null);

export function useActivityContext(): ActivityContextValue {
  const ctx = useContext(ActivityContext);
  if (!ctx) {
    throw new Error("useActivityContext must be used inside ActivityProvider");
  }
  return ctx;
}

/**
 * Publishes "this is still going" to the status bar for as long as `label` is a
 * string, and takes it down on null or on unmount.
 *
 * `id` must be stable and unique to the caller; a literal is the usual thing.
 */
export function useActivity(id: string, label: string | null) {
  const { setActivity } = useActivityContext();
  useEffect(() => {
    setActivity(id, label);
    return () => setActivity(id, null);
  }, [id, label, setActivity]);
}
