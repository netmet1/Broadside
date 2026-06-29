import { useCallback, useEffect, useMemo, useState } from "react";

import { type Host } from "@/lib/tauri/hosts";
import { firstTag } from "@/lib/hostTags";
import { SORT_STORAGE_KEY, type SortKey } from "@/pages/hosts/constants";

/** Column sorting for the hosts table. `null` = the backend's insertion order.
 * The choice persists across tab switches (sessionStorage) but resets on app
 * restart. Status sort needs `connectedHostIds`. */
export function useHostSort(hosts: Host[], connectedHostIds: Set<number>) {
  // Restored from sessionStorage so it survives tab switches, not restart.
  const [sort, setSort] = useState<{
    key: SortKey;
    dir: "asc" | "desc";
  } | null>(() => {
    try {
      const raw = sessionStorage.getItem(SORT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (sort) sessionStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    else sessionStorage.removeItem(SORT_STORAGE_KEY);
  }, [sort]);

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  }, []);

  const sortedHosts = useMemo(() => {
    if (!sort) return hosts;
    const factor = sort.dir === "asc" ? 1 : -1;
    const valueOf = (h: Host): string | number => {
      switch (sort.key) {
        case "label":
          return h.label.toLowerCase();
        case "status":
          return connectedHostIds.has(h.id) ? 0 : 1; // connected first (asc)
        case "hostname":
          return h.hostname.toLowerCase();
        case "port":
          return h.port;
        case "username":
          return h.username.toLowerCase();
        case "tag":
          return firstTag(h.tag);
        case "flavor":
          return (h.linux_flavor ?? "").toLowerCase();
      }
    };
    return [...hosts].sort((a, b) => {
      // Tag sort: by FIRST tag (multi-tag hosts). Untagged hosts always rank
      // after tagged ones, then `factor` flips that — so they sink to the
      // bottom for A-Z and rise to the top for Z-A (user request) rather than
      // clumping with the empty string.
      if (sort.key === "tag") {
        const ta = firstTag(a.tag);
        const tb = firstTag(b.tag);
        const ea = ta === "";
        const eb = tb === "";
        if (ea || eb) {
          if (ea && eb) return a.label.localeCompare(b.label);
          return (ea ? 1 : -1) * factor;
        }
        const cmp = ta.localeCompare(tb, undefined, { sensitivity: "base" });
        if (cmp !== 0) return cmp * factor;
        return a.label.localeCompare(b.label); // stable tiebreak, un-flipped
      }
      const va = valueOf(a);
      const vb = valueOf(b);
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      // Stable, predictable tiebreak by label.
      return a.label.localeCompare(b.label);
    });
  }, [hosts, sort, connectedHostIds]);

  return { sort, toggleSort, sortedHosts };
}
