//! Shared "sort by" ordering for the host/session selection rails on the
//! Broadcast, PTY Broadcast and (future) other pages (B3/P3).

export type RailSort =
  | "az"
  | "za"
  | "tag"
  | "tag-za"
  | "ip"
  | "online"
  | "offline";

export const RAIL_SORT_OPTIONS: { value: RailSort; label: string }[] = [
  { value: "az", label: "Name A-Z" },
  { value: "za", label: "Name Z-A" },
  { value: "tag", label: "Tag A-Z" },
  { value: "tag-za", label: "Tag Z-A" },
  { value: "ip", label: "IP / hostname" },
  { value: "online", label: "Online first" },
  { value: "offline", label: "Offline first" },
];

/** The fields a rail item exposes for sorting. */
type HostLike = { label: string; tag: string | null; hostname: string };

const byLabel = (a: HostLike, b: HostLike) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

/** Orders two items by tag. Untagged items always rank *after* tagged ones;
 * `factor` (1 = A-Z, -1 = Z-A) then flips that, so untagged hosts sink to the
 * bottom for A-Z and rise to the top for Z-A (user request) rather than
 * clumping at the empty-string end. Tagged ties (and untagged ties) fall back
 * to a stable, un-flipped label order. */
const byTag = (a: HostLike, b: HostLike, factor: 1 | -1) => {
  const ta = (a.tag ?? "").trim();
  const tb = (b.tag ?? "").trim();
  const ea = ta === "";
  const eb = tb === "";
  if (ea || eb) {
    if (ea && eb) return byLabel(a, b);
    return (ea ? 1 : -1) * factor;
  }
  const cmp = ta.localeCompare(tb, undefined, { sensitivity: "base" });
  return cmp !== 0 ? cmp * factor : byLabel(a, b);
};

/** Returns a new array of `items` sorted per `sort`. `get` pulls the sortable
 * host fields out of each item (identity for a Host, `s => s.host` for a
 * session). `isOnline` (optional) reports whether an item has a live
 * connection — required for the "online"/"offline" sorts. */
export function sortForRail<T>(
  items: T[],
  get: (item: T) => HostLike,
  sort: string,
  isOnline?: (item: T) => boolean,
): T[] {
  const arr = [...items];
  arr.sort((a, b) => {
    const ha = get(a);
    const hb = get(b);
    switch (sort as RailSort) {
      case "za":
        return byLabel(hb, ha);
      case "tag":
        return byTag(ha, hb, 1);
      case "tag-za":
        return byTag(ha, hb, -1);
      case "ip":
        return (
          ha.hostname.localeCompare(hb.hostname, undefined, { numeric: true }) ||
          byLabel(ha, hb)
        );
      case "online":
      case "offline": {
        const oa = isOnline?.(a) ? 1 : 0;
        const ob = isOnline?.(b) ? 1 : 0;
        // Online-first puts connected items at the top; offline-first inverts.
        if (oa !== ob) return sort === "online" ? ob - oa : oa - ob;
        return byLabel(ha, hb);
      }
      default:
        return byLabel(ha, hb);
    }
  });
  return arr;
}
