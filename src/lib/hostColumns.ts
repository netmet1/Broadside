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
  announce();
}

/**
 * The host-table columns that can be dragged into a different order, in the
 * order they ship in.
 *
 * The three that are not here stay where they are: the checkbox and the colour
 * swatch are the row's left-hand grip and mean nothing anywhere else, and the
 * actions are the tail of the row. Nobody wants to drag Connect into the middle
 * of the address, and leaving them out means the reorder can never produce a
 * table that reads as broken.
 */
export const ORDERABLE_COLUMNS = [
  { id: "label", label: "Label" },
  { id: "status", label: "Status" },
  { id: "hostname", label: "Hostname" },
  { id: "port", label: "Port" },
  { id: "username", label: "Username" },
  { id: "tag", label: "Tag" },
  { id: "flavor", label: "Flavor" },
] as const;

const ORDER_KEY = "hosts-col-order";

/** Fired on this window whenever a host-column pref is written, so Settings and
 * an already-open Hosts table stay in step. The browser's own `storage` event
 * only reaches other documents, so it is no use inside one. Same mechanism as
 * GRID_PREFS_EVENT, and the same reason. */
export const HOST_COLUMNS_EVENT = "broadside:host-columns";

function announce(): void {
  window.dispatchEvent(new Event(HOST_COLUMNS_EVENT));
}

/** The saved column order, repaired against what ships.
 *
 * Anything stored that is no longer a column is dropped, and any column the
 * saved order has never heard of is appended in its shipped position. That way
 * a column added in a later version turns up in everyone's table instead of
 * quietly never rendering, which is the failure mode a bare stored array has.
 */
export function loadColumnOrder(): string[] {
  const shipped = ORDERABLE_COLUMNS.map((c) => c.id as string);
  let saved: string[] = [];
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    if (Array.isArray(raw)) saved = raw.filter((x) => typeof x === "string");
  } catch {
    // Fall through to the shipped order.
  }
  const kept = saved.filter((id) => shipped.includes(id));
  const missing = shipped.filter((id) => !kept.includes(id));
  return [...kept, ...missing];
}

export function saveColumnOrder(order: string[]): void {
  localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  announce();
}

/** Move `dragged` to sit where `target` is, and save. Returns the new order. */
export function reorderColumns(
  order: string[],
  dragged: string,
  target: string,
): string[] {
  if (dragged === target) return order;
  const next = order.filter((id) => id !== dragged);
  const at = next.indexOf(target);
  if (at < 0) return order;
  // In front of the target when moving left, behind it when moving right,
  // which is what "drop it here" means in each direction: dragging a column
  // rightwards past another is a request to end up on the far side of it.
  const movingRight = order.indexOf(dragged) < order.indexOf(target);
  next.splice(movingRight ? at + 1 : at, 0, dragged);
  return next;
}

/** Puts the hosts table's columns back to what ships: every column shown, in
 * the shipped order. Scoped to the columns alone: nothing else in Settings is
 * touched, and neither are the widths, which are dragged on the table itself
 * and are not what this button is next to. */
export function resetHostColumns(): void {
  localStorage.removeItem(KEY);
  localStorage.removeItem(ORDER_KEY);
  announce();
}
