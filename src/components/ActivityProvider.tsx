import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ActivityContext } from "@/lib/activity";

/** Holds the status bar's list of work under way. See `lib/activity.ts` for
 *  what belongs in it. */
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [labels, setLabels] = useState<Map<string, string>>(new Map());

  const setActivity = useCallback((id: string, label: string | null) => {
    setLabels((prev) => {
      // Same as it was is not a change. Without this an entry that re-registers
      // with an unchanged label on every render would hand out a new Map each
      // time and re-render the whole bar for nothing.
      if ((prev.get(id) ?? null) === label) return prev;
      const next = new Map(prev);
      if (label === null) next.delete(id);
      else next.set(id, label);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ activities: [...labels.values()], setActivity }),
    [labels, setActivity],
  );

  return (
    <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>
  );
}
