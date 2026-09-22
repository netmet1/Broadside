import { columnPrefs } from "@/lib/tableColumns";

export { reorderColumns } from "@/lib/tableColumns";

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

/** Fired on this window whenever a host-column pref is written. Same mechanism
 * as GRID_PREFS_EVENT, and the same reason. */
export const HOST_COLUMNS_EVENT = "broadside:host-columns";

export const hostColumnPrefs = columnPrefs({
  hiddenKey: "hosts-hidden-cols",
  orderKey: "hosts-col-order",
  event: HOST_COLUMNS_EVENT,
  orderable: ORDERABLE_COLUMNS,
});

export const loadHiddenCols = hostColumnPrefs.loadHidden;
export const saveHiddenCols = hostColumnPrefs.saveHidden;
export const loadColumnOrder = hostColumnPrefs.loadOrder;
export const saveColumnOrder = hostColumnPrefs.saveOrder;
/** Puts the hosts table's columns back to what ships. Scoped to the columns
 * alone: nothing else in Settings is touched, and neither are the widths. */
export const resetHostColumns = hostColumnPrefs.reset;
