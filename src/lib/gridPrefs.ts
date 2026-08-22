/** Terminal grid layout preferences (Settings -> Grid). A UI pref in
 * localStorage, per-machine and view-only (no backend/DB), mirroring
 * hostColumns / localShellPrefs. Each value is either `null` (== "auto", keep
 * today's fit-to-viewport behavior) or a clamped integer.
 *
 *  - `cols`:     how many tiles sit across (auto = responsive 1 / lg:2).
 *  - `itemCols`: tile WIDTH in characters (columns).
 *  - `itemRows`: tile HEIGHT in characters (rows / lines).
 *
 * "Character" units are converted to pixels at render time from the current
 * terminal cell metrics (see terminalCell.ts). When every value is auto the grid
 * is exactly as it shipped; the moment any value is set, the grid switches to a
 * uniform settings-driven layout. */

const COLS_KEY = "terminal-grid-cols";
const ITEM_COLS_KEY = "terminal-grid-item-cols";
const ITEM_ROWS_KEY = "terminal-grid-item-rows";
const STRICT_KEY = "terminal-grid-strict";
const ROW_FILL_KEY = "terminal-grid-row-fill";
const SEED_COLS_KEY = "terminal-grid-seed-cols";
const SEED_ITEM_COLS_KEY = "terminal-grid-seed-item-cols";
const SEED_ITEM_ROWS_KEY = "terminal-grid-seed-item-rows";

/** Fired on this window whenever any grid pref is written.
 *
 * The browser's own `storage` event only reaches *other* documents, so a write
 * made here is invisible to the rest of this one. Settings and Terminals both
 * hold their own copy of these values, and with strict mode off a drag in the
 * grid changes what Settings should be showing: this is how the other copy
 * finds out, rather than each screen re-reading on a timer or on focus. */
export const GRID_PREFS_EVENT = "broadside:grid-prefs";

function announce(): void {
  window.dispatchEvent(new Event(GRID_PREFS_EVENT));
}

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

/** True when nothing is pinned; the grid should use the shipped fit-to-viewport
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
  } else {
    const clamped = Math.min(Math.max(Math.round(v), min), max);
    localStorage.setItem(key, String(clamped));
  }
  announce();
}

/* ------------------------------------------------------------------ *
 * How the grid behaves, as opposed to what shape it is. Kept apart from
 * `GridPrefs` on purpose: `isAutoGrid` asks whether the *layout* is pinned, and
 * neither of these two is a layout dimension.
 * ------------------------------------------------------------------ */

/** What to do with a last row that isn't full: three tiles in two columns
 * leaves a tile-shaped hole, and this decides what fills it.
 *
 *  - `stretch`: the tiles on the short row widen to take the whole width.
 *  - `tall`:    when exactly one space is left, the tile above it grows down
 *               into the gap, giving a full-height tile in the last column.
 *  - `gaps`:    leave the hole. Every tile keeps the same shape.
 */
export type RowFill = "stretch" | "tall" | "gaps";

export const DEFAULT_ROW_FILL: RowFill = "stretch";

export function loadRowFill(): RowFill {
  const raw = localStorage.getItem(ROW_FILL_KEY);
  return raw === "tall" || raw === "gaps" || raw === "stretch"
    ? raw
    : DEFAULT_ROW_FILL;
}

export function saveRowFill(v: RowFill): void {
  localStorage.setItem(ROW_FILL_KEY, v);
  announce();
}

/**
 * Whether the Grid settings are the last word (`true`, the default).
 *
 * Strict: a tile size dragged out in the Terminals grid is an adjustment to the
 * wall you are looking at right now. It lasts while Broadside runs and is then
 * forgotten, and the numbers in Settings never move, so what you set here is
 * what you get back on every restart.
 *
 * Not strict: a drag is a decision. It writes the tile width and height straight
 * into these settings, Settings shows the new numbers, and the size comes back
 * after a restart. Nothing else about the grid follows the drag either way; the
 * column count, the layout, the tile headers and the two-up flip are unchanged.
 */
export function loadGridStrict(): boolean {
  // Absent means never set, and the default is on, so only an explicit "0"
  // turns it off. Written this way round so a fresh install is strict.
  return localStorage.getItem(STRICT_KEY) !== "0";
}

export function saveGridStrict(v: boolean): void {
  localStorage.setItem(STRICT_KEY, v ? "1" : "0");
  announce();
}

/* ------------------------------------------------------------------ *
 * Seed defaults (Settings -> Grid -> Advanced): what a field starts at
 * the moment its own Auto checkbox is unchecked and it needs a first
 * number to show. Factory-shipped these are 3 / 80 / 24 (80x24 is the
 * classic terminal size); Advanced lets an operator change what "first
 * number" means without touching the pinned values themselves, which
 * keep their own per-field Auto toggle in the main section.
 * ------------------------------------------------------------------ */

export const FACTORY_SEED_COLS = 3;
export const FACTORY_SEED_ITEM_COLS = 80;
export const FACTORY_SEED_ITEM_ROWS = 24;

export type GridSeeds = {
  cols: number;
  itemCols: number;
  itemRows: number;
};

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function loadGridSeeds(): GridSeeds {
  return {
    cols: clampInt(
      localStorage.getItem(SEED_COLS_KEY),
      FACTORY_SEED_COLS,
      GRID_COLS_MIN,
      GRID_COLS_MAX,
    ),
    itemCols: clampInt(
      localStorage.getItem(SEED_ITEM_COLS_KEY),
      FACTORY_SEED_ITEM_COLS,
      GRID_ITEM_COLS_MIN,
      GRID_ITEM_COLS_MAX,
    ),
    itemRows: clampInt(
      localStorage.getItem(SEED_ITEM_ROWS_KEY),
      FACTORY_SEED_ITEM_ROWS,
      GRID_ITEM_ROWS_MIN,
      GRID_ITEM_ROWS_MAX,
    ),
  };
}

export function saveGridSeedCols(v: number): void {
  writeSeed(SEED_COLS_KEY, v, GRID_COLS_MIN, GRID_COLS_MAX);
}
export function saveGridSeedItemCols(v: number): void {
  writeSeed(SEED_ITEM_COLS_KEY, v, GRID_ITEM_COLS_MIN, GRID_ITEM_COLS_MAX);
}
export function saveGridSeedItemRows(v: number): void {
  writeSeed(SEED_ITEM_ROWS_KEY, v, GRID_ITEM_ROWS_MIN, GRID_ITEM_ROWS_MAX);
}

function writeSeed(key: string, v: number, min: number, max: number): void {
  const clamped = Math.min(Math.max(Math.round(v), min), max);
  localStorage.setItem(key, String(clamped));
  announce();
}

/** Back to the factory 3 / 80 / 24, Advanced's own reset button. Does not
 * touch anything else in Grid settings: strict, row fill, or a value
 * already pinned in the main section. */
export function resetGridSeeds(): void {
  localStorage.removeItem(SEED_COLS_KEY);
  localStorage.removeItem(SEED_ITEM_COLS_KEY);
  localStorage.removeItem(SEED_ITEM_ROWS_KEY);
  announce();
}
