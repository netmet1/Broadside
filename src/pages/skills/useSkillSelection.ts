import { useCallback, useEffect, useMemo, useState } from "react";

import { listHosts, type Host } from "@/lib/tauri/hosts";
import { RAIL_SORT_OPTIONS, sortForRail } from "@/lib/railSort";
import { useRailFilter } from "@/lib/useRailFilter";

/** The shared rail sorts minus online/offline: this rail lists saved hosts, not
 * open sessions, so there's no connection state to order by. */
export const SKILL_SORT_OPTIONS = RAIL_SORT_OPTIONS.filter(
  (o) => o.value !== "online" && o.value !== "offline",
);

/** Host selection for the skills rail: the page-level pattern the broadcast
 * pages use (selection + sort + tag/label filter), over saved hosts.
 *
 * Skills target saved hosts rather than open sessions: a run opens its own
 * shell per host, drives it, and closes it. Nothing is pre-selected: the user
 * opts into every run.
 */
export function useSkillSelection(visible: boolean) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [railSort, setRailSort] = useState("az");

  // Refresh on every show so a host added or recoloured elsewhere is current.
  useEffect(() => {
    if (!visible) return;
    listHosts()
      .then(setHosts)
      .catch(() => {
        // The page still works; the rail is just empty.
      });
  }, [visible]);

  const filter = useRailFilter(hosts, "skills-rail-filter");
  const { matches } = filter;

  const sorted = useMemo(
    () => sortForRail(hosts, (h) => h, railSort),
    [hosts, railSort],
  );
  const visibleHosts = useMemo(
    () => sorted.filter((h) => matches(h)),
    [sorted, matches],
  );
  const visibleIds = useMemo(
    () => new Set(visibleHosts.map((h) => h.id)),
    [visibleHosts],
  );

  // Selection stays a subset of what's visible: hiding a host unchecks it, and
  // it stays unchecked once the filter clears (the user re-selects
  // deliberately). Same rule as the broadcast rails.
  useEffect(() => {
    setSelected((prev) => {
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleIds]);

  const toggleHost = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected =
    visibleHosts.length > 0 && visibleHosts.every((h) => selected.has(h.id));

  const toggleAll = useCallback(() => {
    setSelected(allSelected ? new Set() : new Set(visibleIds));
  }, [allSelected, visibleIds]);

  const selectedHosts = useMemo(
    () => hosts.filter((h) => selected.has(h.id)),
    [hosts, selected],
  );

  return {
    hosts,
    visibleHosts,
    selected,
    selectedHosts,
    toggleHost,
    toggleAll,
    allSelected,
    filter,
    railSort,
    setRailSort,
  };
}
