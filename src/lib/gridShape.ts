/**
 * The shape of the terminal grid, as arithmetic.
 *
 * Pulled out of `pages/terminals/useGridLayout` when a second screen needed the
 * same answer: the Templates editor draws a preview of what launching an
 * arrangement will build, and a preview that works it out for itself is a
 * preview that will eventually be wrong. Everything here is a pure function of
 * a tile count and the operator's Grid settings, so both callers get the same
 * layout from the same numbers.
 *
 * Nothing in this file knows what a session is or that terminals exist. It
 * turns "how many boxes, how many columns, what to do with a short last row"
 * into CSS.
 */

import type React from "react";

import type { RowFill } from "@/lib/gridPrefs";

/** Minimum tile width, in characters, when a fixed column count is set but the
 * item width is auto. Keeps a big column count from shaving tiles to slivers.
 * Past this the grid overflows and scrolls horizontally instead. */
export const GRID_FLOOR_COLS = 24;

/** Narrowest a tile of the *default* grid may get before the grid gives up a
 * column and stacks instead, in characters. Deliberately far above
 * GRID_FLOOR_COLS: that one floors a column count the operator pinned by hand,
 * and what they asked for should be honoured almost to the point of absurdity;
 * this one is the grid choosing on their behalf, so it should choose something
 * you can read. */
export const GRID_MIN_TILE_COLS = 48;

/** Slack over the two-column threshold before the second column comes back.
 * Dropping one removes the pane's vertical scrollbar, which widens the content
 * box by roughly this much, and without the margin that alone could put the
 * pane back over the line and the layout would sit there flipping. */
export const GRID_COLS_HYSTERESIS_PX = 16;

/** Per-tile chrome added to the character-derived pixel size: the 1px border on
 * each side (X), and the border plus the grid pane header (Y). Approximate: fit
 * rounds a container to whole cells, so the result lands within ~1 col/row. */
export const TILE_BORDER_X = 2;
export const TILE_BORDER_Y = 2;

/** Legible minimum tile height, in rows **of the terminal font**. Rows fill the
 * pane when few (so a maximized window has no dead space) but never shrink
 * below this, overflowing to a vertical scroll when many.
 *
 * Deliberately not a rem length. `rem` follows the *app* font size (see
 * UiPrefsProvider, which writes it onto the root element) and a terminal cell
 * does not, so a tile floored in rem and a row track floored in px drift apart
 * the moment the app font leaves 16px: at 20px the tile's min-height was 320px
 * inside a 256px track, and since the minimum of a `minmax()` is a fixed length
 * the track never grew to hold it. Every tile spilled 64px into the row below
 * and the error accumulated down the grid, so the tiles overlapped. One number,
 * computed from the metrics it is actually about, cannot do that. */
export const GRID_MIN_TILE_ROWS = 13;

/** How wide a pane has to be before two legible columns fit in it: two tiles at
 * the floor, the gap between them, and the pane's own padding on both sides,
 * because `clientWidth` counts padding in. */
export function twoUpThresholdPx(cellW: number, gapPx: number): number {
  return 2 * (Math.round(GRID_MIN_TILE_COLS * cellW) + TILE_BORDER_X) + 3 * gapPx;
}

/** Does this pane hold two columns? `was` is the current verdict, which is what
 * makes the hysteresis work: the threshold to come back is higher than the one
 * to leave, so removing a column (and with it the pane's scrollbar) cannot put
 * the pane straight back over the line and set the layout oscillating. */
export function fitsTwoUp(paneW: number, threshold: number, was: boolean): boolean {
  return was ? paneW >= threshold : paneW >= threshold + GRID_COLS_HYSTERESIS_PX;
}

/** Which way two tiles split the pane when there are exactly two of them. */
export type TwoUpSplit = "cols" | "rows";

/**
 * The tracks for the **default** (nothing pinned) grid.
 *
 * One terminal fills the pane and two split it, whatever any Grid setting says:
 * those are the two cases where the point is to see one or two machines as
 * large as the pane allows. Two stack when the pane cannot hold them side by
 * side, or when the top/bottom flip asks for it.
 *
 * At three or more the rows are explicit rather than implicit. Left implicit
 * they were `auto`, so every row sized to the tile's own floor and stayed
 * there, and growing the window bought nothing but dead space below the last
 * row. `minmax(floor, 1fr)` shares the pane when the rows fit and holds the
 * legible floor and scrolls when they do not.
 */
export function defaultGridStyle({
  count,
  cols,
  twoUpSplit,
  twoUpFits,
  tileMinH,
}: {
  count: number;
  /** The column count for three or more tiles. Null falls back to one. */
  cols: number | null;
  twoUpSplit: TwoUpSplit;
  twoUpFits: boolean;
  tileMinH: number;
}): React.CSSProperties {
  if (count <= 1) {
    return {
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: "minmax(0, 1fr)",
    };
  }
  if (count === 2) {
    return twoUpSplit === "cols" && twoUpFits
      ? {
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gridTemplateRows: "minmax(0, 1fr)",
        }
      : {
          gridTemplateColumns: "minmax(0, 1fr)",
          gridTemplateRows: "repeat(2, minmax(0, 1fr))",
        };
  }
  return {
    gridTemplateColumns: `repeat(${cols ?? 1}, minmax(0, 1fr))`,
    gridAutoRows: `minmax(${tileMinH}px, 1fr)`,
  };
}

/**
 * Filling a last row that isn't full. Three tiles in two columns leaves a
 * tile-shaped hole at the bottom right, and this is what goes in it.
 *
 *  stretch:  the tiles on the short row widen to share the whole width. The
 *            leftmost takes the odd column when it doesn't divide evenly.
 *  tall:     the tile *above* the gap grows down into it, giving a
 *            full-height tile in the last column. Only when exactly one space
 *            is left: with a wider gap there is no single tile above it, so
 *            it falls back to stretching.
 *  gaps:     nothing. Every tile keeps its own cell.
 *
 * Placement is left to CSS grid's own auto-flow, which follows the `order` the
 * tiles carry. A tall tile occupies its second row before the short row is
 * reached, so the tiles after it fill in beside it without being told to.
 *
 * Both fills make a tile a different size from its neighbours, so neither is
 * allowed to argue with a size you pinned (D4): a stretched tile is wider than
 * the item width, a tall one is taller than the item height. Where the
 * dimension is set by hand, the gap stays; what you asked for wins. That is
 * what `spanCols` / `spanRows` say: the axis is free to be stretched.
 */
export function tileSpan({
  slot,
  count,
  cols,
  rowFill,
  spanCols,
  spanRows,
}: {
  slot: number;
  count: number;
  cols: number | null;
  rowFill: RowFill;
  spanCols: boolean;
  spanRows: boolean;
}): React.CSSProperties | undefined {
  if (rowFill === "gaps") return undefined;
  if (cols == null || cols < 2 || count <= cols) return undefined;
  const rows = Math.ceil(count / cols);
  const lastRowStart = (rows - 1) * cols;
  const lastRowCount = count - lastRowStart;
  const gap = cols - lastRowCount;
  if (gap <= 0) return undefined;

  if (rowFill === "tall" && gap === 1) {
    // The tile directly above the hole: the last one on the row before.
    return spanRows && slot === lastRowStart - 1
      ? { gridRow: "span 2" }
      : undefined;
  }

  if (!spanCols || slot < lastRowStart) return undefined;
  // Share `cols` columns between `lastRowCount` tiles, the remainder going to
  // the leftmost ones so the row ends flush.
  const nth = slot - lastRowStart;
  const span =
    Math.floor(cols / lastRowCount) + (nth < cols % lastRowCount ? 1 : 0);
  return span > 1 ? { gridColumn: `span ${span}` } : undefined;
}
