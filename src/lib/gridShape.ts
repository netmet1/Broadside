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

/** How short a row may be dragged with the tiles unlocked, in rows of the
 * terminal font. Far below GRID_MIN_TILE_ROWS on purpose: that floor is the
 * grid choosing a height on the operator's behalf, and this is the operator
 * asking for a short tile (a log tail under two big shells), which is theirs
 * to ask for. Enough left to read a prompt and a few lines. */
export const GRID_SPLIT_MIN_ROWS = 4;

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
 * How a workspace's grid is sized once a line between its tiles has been
 * dragged with the tiles unlocked, or a template or snapshot brought sizes.
 *
 * `widths`: a tile's width as a fraction of the grid's width (0 to 1), by tab
 * id. A tab without one takes an even share of what its row has left. Keyed
 * by tab rather than by position, so a closed tab takes its width with it and
 * a new one opens at the default.
 *
 * `rows`: each row's height relative to the others (CSS `fr`), top to bottom.
 * By position: a grid with more rows than this gives the new ones an even
 * share and one with fewer ignores the rest, so a row that comes and goes as
 * a tile moves down and back keeps its height.
 *
 * Fractions rather than pixels or characters, so the same arrangement fits a
 * laptop and a wall of monitors, which is what lets a template or a snapshot
 * carry it.
 */
export type GridSizes = { rows: number[]; widths: Record<string, number> };

/** One tile of a flowed grid: its row (and how many it spans, two only for
 * the "tall" short-row fill), and its left edge and width as fractions of the
 * grid's width. */
export type FlowTile = { row: number; rowSpan: number; x: number; w: number };

/** A line between tiles that a drag can move, side to side.
 *  - `pair`: between two tiles in a row. One grows by what the other gives
 *    up, and the right one moves down a row once it would be left at or under
 *    the minimum width.
 *  - `edge`: the right edge of the last tile in a row that is alone or has
 *    blank space beside it. Only that tile changes. */
export type FlowLine =
  | { kind: "pair"; left: number; right: number }
  | { kind: "edge"; slot: number };

export type Flow = {
  rows: number;
  /** By slot. */
  tiles: FlowTile[];
  /** The line on each tile's left and right edge, by slot; null where a drag
   * has nothing to move. */
  leftLine: (FlowLine | null)[];
  rightLine: (FlowLine | null)[];
  /** Every distinct left and right edge, 0 to 1: the grid's column lines. */
  edges: number[];
};

const EPS = 1e-6;

/**
 * Lay the tiles out in rows, in tab order, the way text wraps. `cols` is how
 * many a row holds. A tile with a width keeps it, and the tiles without one
 * share what their row has left. A tile goes onto the next row when the row
 * is full, when its width does not fit, or when it (or a tile without a width
 * already there) would be left at or under `min`.
 *
 * With no widths at all this is the default grid: `cols` to a row, and a
 * short last row filled per the Grid setting. "Tall" is a span down into the
 * last row, which only works while the row above is two tiles edge to edge,
 * so it holds only while the tile under it has no width of its own.
 *
 * With one column every tile has a row to itself at full width, whatever its
 * width says: a pane too narrow for two is too narrow for blank space.
 */
export function flowLayout({
  widths,
  cols,
  min,
  rowFill,
}: {
  /** By slot: a fraction of the grid's width, or null for none. */
  widths: (number | null)[];
  cols: number;
  /** The narrowest a tile may be, as a fraction of the grid's width. */
  min: number;
  rowFill: RowFill;
}): Flow {
  const count = widths.length;
  const c = Math.max(cols, 1);
  const own = (i: number): number | null => {
    const w = c < 2 ? null : (widths[i] ?? null);
    return w == null ? null : Math.min(Math.max(w, 0), 1);
  };

  const rows: number[][] = [];
  let cur: number[] = [];
  let fixed = 0;
  let free = 0;
  for (let i = 0; i < count; i++) {
    const w = own(i);
    let fits = cur.length > 0 && cur.length < c;
    if (fits) {
      const left = 1 - fixed - (w ?? 0);
      const sharing = free + (w == null ? 1 : 0);
      fits = left > -EPS && (sharing === 0 || left / sharing > min + EPS);
    }
    if (!fits && cur.length > 0) {
      rows.push(cur);
      cur = [];
      fixed = 0;
      free = 0;
    }
    cur.push(i);
    if (w == null) free++;
    else fixed += w;
  }
  if (cur.length > 0) rows.push(cur);

  const tiles: FlowTile[] = [];
  const lastRow = rows.length - 1;
  rows.forEach((slots, r) => {
    const sizes = slots.map(own);
    const taken = sizes.reduce<number>((a, w) => a + (w ?? 0), 0);
    const sharing = sizes.filter((w) => w == null).length;
    let share = sharing > 0 ? Math.max(1 - taken, 0) / sharing : 0;
    if (rowFill === "gaps" && r === lastRow && c >= 2) {
      share = Math.min(share, 1 / c);
    }
    let x = 0;
    slots.forEach((i, k) => {
      const w = Math.max(Math.min(sizes[k] ?? share, 1 - x), 0);
      tiles[i] = { row: r, rowSpan: 1, x, w };
      x += w;
    });
  });

  const leftLine = new Array<FlowLine | null>(count).fill(null);
  const rightLine = new Array<FlowLine | null>(count).fill(null);
  if (c >= 2) {
    for (const slots of rows) {
      const used = slots.reduce((a, i) => a + tiles[i]!.w, 0);
      slots.forEach((i, k) => {
        if (k > 0) leftLine[i] = { kind: "pair", left: slots[k - 1]!, right: i };
        if (k < slots.length - 1) {
          rightLine[i] = { kind: "pair", left: i, right: slots[k + 1]! };
        } else if (slots.length === 1 || used < 1 - EPS) {
          rightLine[i] = { kind: "edge", slot: i };
        }
      });
    }
  }

  if (rowFill === "tall" && c === 2 && rows.length >= 2) {
    const last = rows[lastRow]!;
    const above = rows[lastRow - 1]!;
    const aboveUsed = above.reduce((a, i) => a + tiles[i]!.w, 0);
    if (
      last.length === 1 &&
      own(last[0]!) == null &&
      above.length === 2 &&
      aboveUsed > 1 - EPS
    ) {
      const [first, tall] = above as [number, number];
      tiles[tall] = { ...tiles[tall]!, rowSpan: 2 };
      tiles[last[0]!] = { row: lastRow, rowSpan: 1, x: 0, w: tiles[first]!.w };
      rightLine[last[0]!] = { kind: "pair", left: first, right: tall };
    }
  }

  const edges: number[] = [];
  const sorted = [0, 1, ...tiles.flatMap((t) => [t.x, t.x + t.w])].sort(
    (a, b) => a - b,
  );
  for (const v of sorted) {
    if (edges.length === 0 || v - edges[edges.length - 1]! > 0.002) edges.push(v);
  }
  edges[edges.length - 1] = 1;

  return { rows: rows.length, tiles, leftLine, rightLine, edges };
}

/** `sizes` stretched or cut to `n` rows, the new ones at an even share. */
export function flowRowSizes(
  sizes: number[] | null | undefined,
  n: number,
): number[] {
  return Array.from({ length: n }, (_, i) => sizes?.[i] ?? 1);
}

/** The grid's tracks for a flow: a column between each pair of neighbouring
 * edges, and the rows at `rowSizes`, none shorter than `rowMin`. The columns
 * are in hundredths so they sum to 100, because `fr` values that sum to under
 * 1 leave part of the grid unused. */
export function flowGridStyle(
  flow: Flow,
  rowSizes: number[] | null | undefined,
  rowMin: string,
): React.CSSProperties {
  const cols = flow.edges
    .slice(1)
    .map((e, i) => Math.round((e - flow.edges[i]!) * 100000) / 1000);
  return {
    gridTemplateColumns: cols.map((f) => `minmax(0, ${f}fr)`).join(" "),
    gridTemplateRows: flowRowSizes(rowSizes, flow.rows)
      .map((f) => `minmax(${rowMin}, ${f}fr)`)
      .join(" "),
  };
}

/** Where the tile in `slot` sits in the grid `flowGridStyle` makes. */
export function flowPlace(flow: Flow, slot: number): React.CSSProperties {
  const t = flow.tiles[slot];
  if (!t) return {};
  const at = (v: number) => {
    let best = 0;
    flow.edges.forEach((e, i) => {
      if (Math.abs(e - v) < Math.abs(flow.edges[best]! - v)) best = i;
    });
    return best;
  };
  const a = at(t.x);
  const b = Math.max(at(t.x + t.w), a + 1);
  return {
    gridRow: `${t.row + 1} / span ${t.rowSpan}`,
    gridColumn: `${a + 1} / ${b + 1}`,
  };
}

/** Scale a list of sizes so they average 1: the same proportions, in numbers
 * that read as `fr` and stay small whatever pixel sizes they came from. */
export function normalizeTracks(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return sizes.map(() => 1);
  return sizes.map((s) => Math.round(((s * sizes.length) / sum) * 1000) / 1000);
}
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
 *
 * This is the grid the Templates editor previews when a size is pinned in
 * Settings. The Terminals tab's own default grid is `flowLayout`, which can
 * also hold the widths and heights dragged with the tiles unlocked.
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
