import { useCallback, useMemo, useState } from "react";

import { type Host } from "@/lib/tauri/hosts";
import { sortForRail } from "@/lib/railSort";
import { HEADERS_KEY, RAIL_COLLAPSED_KEY } from "@/pages/broadcast/model";

/** Host-selection rail state for the Broadcast page (mirrors MultiTerminal):
 * persisted collapse + per-host output headers toggles, plus the rail sort
 * order and the sorted host list it produces. */
export function useBroadcastRail(
  hosts: Host[],
  connectedHostIds: Set<number>,
) {
  // Collapsible host rail (mirrors MultiTerminal's O1), persisted.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // Per-host output headers toggle (O4): default ON; off = output only.
  const [headers, setHeaders] = useState(
    () => localStorage.getItem(HEADERS_KEY) !== "0",
  );
  const toggleHeaders = useCallback(() => {
    setHeaders((prev) => {
      const next = !prev;
      localStorage.setItem(HEADERS_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // Rail sort order (B3). Component stays mounted so this survives tab switches.
  const [railSort, setRailSort] = useState("az");
  const railHosts = useMemo(
    () =>
      sortForRail(hosts, (h) => h, railSort, (h) => connectedHostIds.has(h.id)),
    [hosts, railSort, connectedHostIds],
  );
  // When the rail is ordered by tag, surface each host's tag in the row so the
  // grouping the user is sorting by is actually visible (otherwise only the
  // label shows and the tag sort looks arbitrary).
  const showRailTag = railSort === "tag" || railSort === "tag-za";

  return {
    railCollapsed,
    toggleRail,
    headers,
    toggleHeaders,
    railSort,
    setRailSort,
    railHosts,
    showRailTag,
  };
}
