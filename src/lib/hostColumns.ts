/** Host-table columns the user may hide from Settings → Appearance (the
 * "nice to have" ones; label, hostname, actions etc. are always shown). The
 * chosen set is a UI pref in localStorage, read by the Hosts table on mount. */

export const HIDEABLE_COLUMNS = [
  { id: "status", label: "Status" },
  { id: "port", label: "Port" },
  { id: "username", label: "Username" },
  { id: "tag", label: "Tag" },
  { id: "flavor", label: "Flavor" },
] as const;

const KEY = "hosts-hidden-cols";

export function loadHiddenCols(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(raw)) return new Set(raw.filter((x) => typeof x === "string"));
  } catch {
    // Fall through to an empty set (all columns visible).
  }
  return new Set();
}

export function saveHiddenCols(hidden: Set<string>): void {
  localStorage.setItem(KEY, JSON.stringify([...hidden]));
}
