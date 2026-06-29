export type SortKey =
  | "label"
  | "status"
  | "hostname"
  | "port"
  | "username"
  | "tag"
  | "flavor";

/** Column layout for the hosts table. Resizable columns get a drag handle and
 * their width persists in localStorage (across tab switches and restarts). */
export const COLS: { id: string; w: number; resizable: boolean }[] = [
  { id: "select", w: 40, resizable: false },
  { id: "swatch", w: 40, resizable: false },
  { id: "label", w: 180, resizable: true },
  { id: "status", w: 64, resizable: false },
  { id: "hostname", w: 220, resizable: true },
  { id: "port", w: 90, resizable: true },
  { id: "username", w: 150, resizable: true },
  { id: "tag", w: 120, resizable: true },
  { id: "flavor", w: 130, resizable: true },
  { id: "actions", w: 210, resizable: false },
];
export const COL_WIDTHS_KEY = "hosts-col-widths";
export const MIN_COL_W = 56;
// Sort persists across tab switches (sessionStorage survives remount) but
// resets on app restart (sessionStorage clears when the window closes).
export const SORT_STORAGE_KEY = "hosts-sort";
// Tag filter (the unchecked tags) persists for the session only, same as sort.
export const TAG_FILTER_KEY = "hosts-tag-filter";
// Sentinel for the "(untagged)" row in the tag filter dropdown. The leading
// NUL (written as an escape to keep this source file ASCII) can never collide
// with a real tag name.
export const UNTAGGED_KEY = "\u0000untagged";

/** Local-time `YYYYMMDD-HHMMSS` stamp for default export filenames (H6). */
export function dtStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
