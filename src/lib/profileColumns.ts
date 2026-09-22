import { columnPrefs } from "@/lib/tableColumns";

/**
 * The columns of the Profiles table on the Hosts tab that can be moved and
 * hidden, the same way the Hosts table's can (smoke test 69-6, I).
 *
 * Name always shows: a row without it is a row you cannot identify. The grip,
 * tick box and colour dot on the left and the actions on the right are fixed,
 * for the reason the Hosts table's are: they bracket the row, and moving them
 * into the middle could only make it read as broken.
 */
export const PROFILE_ORDERABLE_COLUMNS = [
  { id: "name", label: "Name" },
  { id: "shell", label: "Shell" },
  { id: "folder", label: "Folder" },
  { id: "startup", label: "Startup command" },
] as const;

export const PROFILE_HIDEABLE_COLUMNS = [
  { id: "shell", label: "Shell" },
  { id: "folder", label: "Folder" },
  { id: "startup", label: "Startup command" },
] as const;

/** Every column with its shipped width, fixed ones included. They add up to
 * 900 px, so the whole row, the open button in Actions included, fits the
 * table's width at the smallest window (1024 wide, less the rail and padding)
 * without a sideways scroll. Widen any of them by dragging. */
export const PROFILE_COLS: { id: string; w: number }[] = [
  { id: "grip", w: 28 },
  { id: "select", w: 40 },
  { id: "swatch", w: 36 },
  { id: "name", w: 170 },
  { id: "shell", w: 120 },
  { id: "folder", w: 180 },
  { id: "startup", w: 150 },
  { id: "actions", w: 176 },
];

export const PROFILE_COL_WIDTHS_KEY = "profiles-col-widths";

export const PROFILE_COLUMNS_EVENT = "broadside:profile-columns";

export const profileColumnPrefs = columnPrefs({
  hiddenKey: "profiles-hidden-cols",
  orderKey: "profiles-col-order",
  event: PROFILE_COLUMNS_EVENT,
  orderable: PROFILE_ORDERABLE_COLUMNS,
});
