/** Terminal grid layout preferences (Settings -> Grid). A UI pref in
 * localStorage, per-machine and view-only (no backend/DB), mirroring
 * hostColumns / localShellPrefs. Each value is either `null` (== "auto", keep
 * today's fit-to-viewport behavior) or a clamped integer.
 *
 *  - `cols`     — how many tiles sit across (auto = responsive 1 / lg:2).
 *  - `itemCols` — tile WIDTH in characters (columns).
 *  - `itemRows` — tile HEIGHT in characters (rows / lines).
 *
 * "Character" units are converted to pixels at render time from the current
 * terminal cell metrics (see terminalCell.ts). When every value is auto the grid
 * is exactly as it shipped; the moment any value is set, the grid switches to a
 * uniform settings-driven layout. */

const COLS_KEY = "terminal-grid-cols";
const ITEM_COLS_KEY = "terminal-grid-item-cols";
const ITEM_ROWS_KEY = "terminal-grid-item-rows";

/** Clamp bounds. Deliberately conservative: the max column count and the
 * character extents keep a fixed grid from being pathological, and the minimums
 * keep a tile usable. */
export const GRID_COLS_MIN = 1;
export const GRID_COLS_MAX = 12;
export const GRID_ITEM_COLS_MIN = 20;
export const GRID_ITEM_COLS_MAX = 400;
export const GRID_ITEM_ROWS_MIN = 4;
export const GRID_ITEM_ROWS_MAX = 200;

/** `null` on any field means "auto" (keep the default behavior for that axis). */
export type GridPrefs = {
  cols: number | null;
  itemCols: number | null;
  itemRows: number | null;
};

export const AUTO_GRID_PREFS: GridPrefs = {
  cols: null,
  itemCols: null,
  itemRows: null,
};

/** True when nothing is pinned — the grid should use the shipped fit-to-viewport
 * behavior (1 fills, 2-up split + flip, 3+ tile two-across and scroll). */
export function isAutoGrid(p: GridPrefs): boolean {
  return p.cols === null && p.itemCols === null && p.itemRows === null;
}

function clampOrNull(raw: string | null, min: number, max: number): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

export function loadGridPrefs(): GridPrefs {
  return {
    cols: clampOrNull(
      localStorage.getItem(COLS_KEY),
      GRID_COLS_MIN,
      GRID_COLS_MAX,
    ),
    itemCols: clampOrNull(
      localStorage.getItem(ITEM_COLS_KEY),
      GRID_ITEM_COLS_MIN,
      GRID_ITEM_COLS_MAX,
    ),
    itemRows: clampOrNull(
      localStorage.getItem(ITEM_ROWS_KEY),
      GRID_ITEM_ROWS_MIN,
      GRID_ITEM_ROWS_MAX,
    ),
  };
}

/** Persist one field. `null` clears it back to auto. Values are clamped so a
 * stored pref is always in range regardless of how it got there. */
export function saveGridCols(v: number | null): void {
  writeField(COLS_KEY, v, GRID_COLS_MIN, GRID_COLS_MAX);
}
export function saveGridItemCols(v: number | null): void {
  writeField(ITEM_COLS_KEY, v, GRID_ITEM_COLS_MIN, GRID_ITEM_COLS_MAX);
}
export function saveGridItemRows(v: number | null): void {
  writeField(ITEM_ROWS_KEY, v, GRID_ITEM_ROWS_MIN, GRID_ITEM_ROWS_MAX);
}

function writeField(
  key: string,
  v: number | null,
  min: number,
  max: number,
): void {
  if (v === null) {
    localStorage.removeItem(key);
    return;
  }
  const clamped = Math.min(Math.max(Math.round(v), min), max);
  localStorage.setItem(key, String(clamped));
}
