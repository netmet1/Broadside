/**
 * Everything the Terminals **Grid** view needs to decide how it looks: which
 * layout is active, which tiles are in it, what order they sit in, and the CSS
 * that lays them out.
 *
 * Extracted from `TerminalsPage`, which was carrying the whole page. Nothing
 * here touches a PTY or a session's lifetime; it is layout only, so it can be
 * reasoned about (and changed) without risk to a live terminal.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  GRID_PREFS_EVENT,
  isAutoGrid,
  loadGridPrefs,
  loadGridStrict,
  loadRowFill,
  saveGridItemCols,
  saveGridItemRows,
  type GridPrefs,
  type RowFill,
} from "@/lib/gridPrefs";
import { measureTerminalCell } from "@/lib/terminalCell";
import { useUiPrefs } from "@/lib/uiPrefs";
import type { TermSession } from "@/pages/terminals/session";

const LAYOUT_KEY = "terminal-layout";
/** Grid tile chrome: "1" hides every tile's title bar. Persisted so the cleaner
 * look survives a restart. */
const GRID_HIDE_HEADERS_KEY = "terminal-grid-hide-headers";

/** Minimum tile width, in characters, when a fixed column count is set but the
 * item width is auto. Keeps a big column count from shaving tiles to slivers.
 * Past this the grid overflows and scrolls horizontally instead. */
const GRID_FLOOR_COLS = 24;
/** Narrowest a tile of the *default* grid may get before the grid gives up a
 * column and stacks instead, in characters. Deliberately far above
 * GRID_FLOOR_COLS: that one floors a column count the operator pinned by hand,
 * and what they asked for should be honoured almost to the point of absurdity;
 * this one is the grid choosing on their behalf, so it should choose something
 * you can read. */
const GRID_MIN_TILE_COLS = 48;
/** Slack over the two-column threshold before the second column comes back.
 * Dropping one removes the pane's vertical scrollbar, which widens the content
 * box by roughly this much, and without the margin that alone could put the
 * pane back over the line and the layout would sit there flipping. */
const GRID_COLS_HYSTERESIS_PX = 16;
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
const GRID_MIN_TILE_ROWS = 13;

/** The real height of a tile's title bar. Also not a constant: the header is
 * `py-1` plus a `text-sm` line box plus 3px of border, all of which scale with
 * the app font, so a hard-coded 30 was only ever right at a 16px app font (this
 * returns 31 there, and 38 at 20px). Zero when the titles are hidden, because
 * then there is no header to make room for. */
function gridHeaderH(appFontSize: number, hidden: boolean): number {
  return hidden ? 0 : Math.round(1.75 * appFontSize) + 3;
}
/** How the open terminals are laid out below the tab strip: one pane at a time
 * (the default) or every pane tiled at once, mirroring the skill run panel. */
export type TermLayout = "tabs" | "grid";

export type GridLayout = {
  layout: TermLayout;
  chooseLayout: (next: TermLayout) => void;
  /** Grid is actually showing: the layout is grid AND nothing is maximized. */
  gridMode: boolean;

  /** Panes in stable creation order, the DOM order they are rendered in. */
  paneOrder: TermSession[];
  /** Tiles the grid actually lays out (creation order, exclusions removed). */
  gridTiles: TermSession[];
  /** How many tiles the grid shows. Drives the 1 / 2 / 3+ layout. */
  gridCount: number;
  /** Each session's position in the tab strip, for the CSS `order` property. */
  displayIndex: Map<string, number>;

  excludedFromGrid: Set<string>;
  toggleGridExcluded: (id: string) => void;
  /** Put every hidden terminal back in the grid at once. The per-tab eye button
   * is fine for one; it is not a way out of a grid you have emptied. */
  clearGridExcluded: () => void;

  hideGridHeaders: boolean;
  toggleGridHeaders: () => void;

  twoUpSplit: "cols" | "rows";
  toggleTwoUpSplit: () => void;

  /** The Settings -> Grid prefs with this session's dragged tile size applied
   * over the top (see `setDragCols`). What the grid actually lays out to. */
  gridPrefs: GridPrefs;

  /** Set the dragged tile width / height, in characters, for this session only.
   * Drives the tile size without touching the saved Settings values. */
  setDragCols: (cols: number) => void;
  setDragRows: (rows: number) => void;
  /** Drop the dragged size and clear any pinned tile size in Settings, putting
   * the grid back to tiles that fit the window. */
  resetTileSize: () => void;
  /** Measured cell size for the current terminal font, for char <-> px maths. */
  cell: { cellW: number; cellH: number };
  /** A tile's title bar in px, for the char <-> px maths that has to allow for
   * it. Zero when the titles are hidden, and it grows with the app font. */
  headerH: number;
  /** A tile's legible minimum height in px. The row track's floor and the tile's
   * own `min-height` are handed this same number, so they cannot disagree. */
  tileMinH: number;

  /** True while the Grid settings are the last word and a drag is temporary
   * (the default). False lets a drag write the tile size into Settings. */
  strictGrid: boolean;
  /** Each grid tile's rank in the laid-out order, keyed by session id. Not the
   * same as `displayIndex`: tiles hidden from the grid are skipped, so these
   * are the contiguous slots the CSS grid actually fills. */
  gridSlot: Map<string, number>;
  /** How many columns the grid really has right now, the pinned count trimmed
   * to the number of tiles (D3), or the responsive default. `null` when it
   * cannot be known (tiles of a fixed width auto-filling the container). */
  effectiveCols: number | null;
  /** Extra placement for the tile in slot `n`, filling a short last row per the
   * Grid setting. `undefined` for tiles that just take their own cell. */
  tileSpan: (slot: number) => React.CSSProperties | undefined;

  /** A settings-driven uniform grid is in force (see the note on the exception
   * at two tiles). */
  customGrid: boolean;
  gridStyle: React.CSSProperties | undefined;
};

export function useGridLayout({
  sessions,
  visible,
  maximized,
  paneRef,
}: {
  sessions: TermSession[];
  visible: boolean;
  maximized: boolean;
  /** The element the tiles are laid out in. Measured rather than assumed: how
   * much room the grid has is not the window's width, it is what the sidebar
   * and the broadcast rail have left of it. */
  paneRef: React.RefObject<HTMLDivElement | null>;
}): GridLayout {
  // Pane layout: one tab at a time (default) or every pane tiled like the skill
  // run panel. Persisted in localStorage so it survives tab switches (the page
  // stays mounted anyway) and program restarts. Maximizing always collapses to
  // the single fullscreen pane, so grid only applies when not maximized.
  const [layout, setLayout] = useState<TermLayout>(() =>
    localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "tabs",
  );
  const chooseLayout = useCallback((next: TermLayout) => {
    setLayout(next);
    localStorage.setItem(LAYOUT_KEY, next);
  }, []);
  const gridMode = layout === "grid" && !maximized;

  // Hide every grid tile's title bar for a denser, chrome-free wall of
  // terminals. The choice persists across restarts.
  const [hideGridHeaders, setHideGridHeaders] = useState(
    () => localStorage.getItem(GRID_HIDE_HEADERS_KEY) === "1",
  );
  const toggleGridHeaders = useCallback(() => {
    setHideGridHeaders((h) => {
      localStorage.setItem(GRID_HIDE_HEADERS_KEY, h ? "0" : "1");
      return !h;
    });
  }, []);

  // How the special two-terminal grid is split: side-by-side columns (default)
  // or stacked top/bottom rows. Deliberately plain component state, NOT
  // persisted, the page stays mounted for the whole session so the choice
  // sticks across tab switches, but it resets to side-by-side on a restart.
  const [twoUpSplit, setTwoUpSplit] = useState<"cols" | "rows">("cols");
  const toggleTwoUpSplit = useCallback(
    () => setTwoUpSplit((s) => (s === "cols" ? "rows" : "cols")),
    [],
  );

  // Terminal panes are rendered in stable creation order, decoupled from the
  // (drag-reorderable) tab order. The active pane is shown via CSS regardless of
  // its position, so pane order is invisible to the user -- and keeping it stable
  // means dragging a tab never moves a pane's DOM node, so the live xterm/PTY is
  // never torn down or remounted by a reorder.
  const paneOrder = useMemo(
    () => [...sessions].sort((a, b) => a.seq - b.seq),
    [sessions],
  );

  // Where each pane sits *visually* in the grid: its position in the tab strip.
  // Applied as the CSS `order` property rather than by sorting the rendered
  // list, so the pane DOM stays in creation order (see paneOrder above) and a
  // tab drag reflows the grid without moving a single node or remounting a
  // live terminal. CSS grid auto-placement follows order-modified order.
  const displayIndex = useMemo(() => {
    const m = new Map<string, number>();
    sessions.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [sessions]);

  // Terminals the operator has taken out of the grid via the tab's grid toggle.
  // The shell keeps running and its tab still selects it in Tabs layout; it
  // just doesn't claim a tile. Session-lifetime only, like twoUpSplit above:
  // session ids are fresh UUIDs each run, so a persisted set would have nothing
  // to reattach to on the next launch.
  const [excludedFromGrid, setExcludedFromGrid] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleGridExcluded = useCallback((id: string) => {
    setExcludedFromGrid((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  // Returns the same set when it is already empty, so a menu that offers this
  // unconditionally can't cause a re-render by being clicked with nothing hidden.
  const clearGridExcluded = useCallback(() => {
    setExcludedFromGrid((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);
  // Drop ids whose session has closed so the set can't grow without bound.
  // Adjusted during render rather than in an effect; the early return on an
  // empty set and the identity return when nothing was dropped are what make
  // it converge.
  const [prevSessions, setPrevSessions] = useState(sessions);
  if (prevSessions !== sessions) {
    setPrevSessions(sessions);
    setExcludedFromGrid((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(sessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }

  const gridTiles = useMemo(
    () => paneOrder.filter((s) => !excludedFromGrid.has(s.id)),
    [paneOrder, excludedFromGrid],
  );
  // How many tiles the grid shows, drives the fill/split/scroll layout (B3).
  // Excluded panes don't count, so hiding one of three tiles gives the real
  // two-up split rather than a two-up-shaped hole.
  const gridCount = gridTiles.length;

  // Grid layout prefs (Settings -> Grid): pinned column count and character-based
  // tile size, or auto. Re-read whenever the page is shown so a change made in
  // Settings (this page stays mounted) takes effect on return, like disabledShells.
  const [savedPrefs, setSavedPrefs] = useState<GridPrefs>(loadGridPrefs);
  const [strictGrid, setStrictGrid] = useState<boolean>(loadGridStrict);
  const [rowFill, setRowFill] = useState<RowFill>(loadRowFill);
  const reloadPrefs = useCallback(() => {
    setSavedPrefs(loadGridPrefs());
    setStrictGrid(loadGridStrict());
    setRowFill(loadRowFill());
  }, []);
  // Adjusted on the visibility transition during render rather than in an
  // effect. `reloadPrefs` is synchronous (it reads localStorage), so in an
  // effect it renders the stale prefs once and then corrects them, which on a
  // return to a pinned grid is a visible reflow. This is React's documented
  // way to reset state derived from a prop, and it converges: the guard is
  // false again the moment `wasVisible` catches up.
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible) reloadPrefs();
  }
  // Also whenever anything writes a grid pref, from either screen. Coming back
  // to Terminals is no longer the only moment these can change: with strict off
  // a drag writes them itself, and Settings has to show the result.
  useEffect(() => {
    window.addEventListener(GRID_PREFS_EVENT, reloadPrefs);
    return () => window.removeEventListener(GRID_PREFS_EVENT, reloadPrefs);
  }, [reloadPrefs]);

  // How wide the pane laying the tiles out actually is. The default grid used
  // to say `lg:grid-cols-2`, a media query on the *window*, which cannot see
  // that the sidebar (up to 225px) and the broadcast rail (224px) come out of
  // this same pane: at the minimum window with both open it still laid two
  // columns into 575px and handed back 35-character terminals. Rows have had a
  // legible floor and a scroll to overflow into since the start; this is the
  // other half of that, on the axis that was missing it.
  const [paneW, setPaneW] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPaneW(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [paneRef]);

  // A tile size dragged out with the resize handles, in characters. Plain
  // component state, deliberately NOT persisted and deliberately NOT written
  // into Settings: dragging a tile is an adjustment to the wall you are looking
  // at right now, not a decision about how the grid should open next time. It
  // lasts as long as the program is running (the page stays mounted), and a
  // restart comes back to whatever Settings says. Settings -> Grid stays the
  // one place a lasting size is set.
  const [dragSize, setDragSize] = useState<{
    cols: number | null;
    rows: number | null;
  }>({ cols: null, rows: null });
  //
  // Unless strict mode is off, in which case the paragraph above is exactly
  // what the operator has said they do not want: the drag is written straight
  // into Settings, so the numbers there follow the wall and the size comes back
  // after a restart. Only the tile size, and only from the drag handles;
  // nothing else in the toolbar writes a setting either way.
  const setDragCols = useCallback(
    (cols: number) => {
      setDragSize((s) => (s.cols === cols ? s : { ...s, cols }));
      if (!strictGrid) saveGridItemCols(cols);
    },
    [strictGrid],
  );
  const setDragRows = useCallback(
    (rows: number) => {
      setDragSize((s) => (s.rows === rows ? s : { ...s, rows }));
      if (!strictGrid) saveGridItemRows(rows);
    },
    [strictGrid],
  );
  // Reset size means "tiles that fit the window", so it has to clear both the
  // dragged size and any size pinned in Settings, or the button would appear to
  // do nothing for someone who set the numbers by hand.
  const resetTileSize = useCallback(() => {
    setDragSize({ cols: null, rows: null });
    saveGridItemCols(null);
    saveGridItemRows(null);
    reloadPrefs();
  }, [reloadPrefs]);

  // What the grid lays out to: the saved prefs with the dragged size over the
  // top. A drag only ever overrides the tile size; the column count stays
  // whatever Settings says, since there is no handle for it.
  const gridPrefs = useMemo<GridPrefs>(
    () =>
      dragSize.cols === null && dragSize.rows === null
        ? savedPrefs
        : {
            cols: savedPrefs.cols,
            itemCols: dragSize.cols ?? savedPrefs.itemCols,
            itemRows: dragSize.rows ?? savedPrefs.itemRows,
          },
    [savedPrefs, dragSize],
  );

  // One cell measurement serves every tile (all terminals share the app font).
  const { prefs: uiPrefs } = useUiPrefs();
  const cell = useMemo(
    () =>
      measureTerminalCell(uiPrefs.terminalFontFamily, uiPrefs.terminalFontSize),
    [uiPrefs.terminalFontFamily, uiPrefs.terminalFontSize],
  );

  // The two pieces of per-tile chrome the layout has to pay for, both derived
  // rather than written down (see gridHeaderH). Everything that needs a tile's
  // minimum height takes `tileMinH`, so the row track and the tile itself are
  // always the same number and a tile can never outgrow the row holding it.
  const headerH = gridHeaderH(uiPrefs.appFontSize, hideGridHeaders);
  const tileMinH =
    Math.round(GRID_MIN_TILE_ROWS * cell.cellH) + headerH + TILE_BORDER_Y;
  /** The pane's `gap-2` in pixels. Another rem, so another thing that is not a
   * constant once the app font moves off 16px. */
  const gapPx = Math.round(0.5 * uiPrefs.appFontSize);

  // A non-auto grid switches to a uniform, settings-driven layout.
  //
  // One and two tiles are the deliberate exceptions: a single terminal fills the
  // whole area and two split it (with the top/bottom flip), whatever the Grid
  // settings say. Those are the two cases where the point is to see one or two
  // machines as large as the window allows, so a pinned column count or tile
  // size can only get in the way: three columns with one terminal open left a
  // third of a screen in use and two thirds empty.
  const customGrid = gridMode && !isAutoGrid(gridPrefs) && gridCount > 2;
  // How many columns to actually lay out (D3). A pinned count is trimmed to the
  // number of tiles: six columns with three terminals open used half the window
  // and left the rest empty, and there is nothing for the other three columns to
  // do. It only ever shrinks the count, so it cannot fight a deliberately wide
  // setting, and it changes no tile's *size*, a pinned item width or height is
  // still exactly what it says (D4).
  const pinnedCols =
    gridPrefs.cols != null ? Math.min(gridPrefs.cols, Math.max(gridCount, 1)) : null;

  // Whether the pane can hold two legible columns, hysteresis included. Two
  // tiles at the floor, the gap between them, and the pane's own `p-2` on both
  // sides, because `clientWidth` counts padding in.
  const [twoUpFits, setTwoUpFits] = useState(true);
  const twoUpThreshold =
    2 * (Math.round(GRID_MIN_TILE_COLS * cell.cellW) + TILE_BORDER_X) +
    3 * gapPx;
  useEffect(() => {
    if (paneW === 0) return;
    setTwoUpFits((fits) =>
      fits
        ? paneW >= twoUpThreshold
        : paneW >= twoUpThreshold + GRID_COLS_HYSTERESIS_PX,
    );
  }, [paneW, twoUpThreshold]);

  // The real column count, for both the layout and the short-row fill, which
  // have to agree: the fill decides which tiles widen to close a gap, so a
  // count that disagreed with the tracks would put the gap in the wrong place.
  // Unknowable only for tiles of a fixed width auto-filling the row, where the
  // count comes from the measured container rather than from a setting.
  const effectiveCols = useMemo<number | null>(() => {
    if (!gridMode) return null;
    if (pinnedCols != null) return pinnedCols;
    if (customGrid && gridPrefs.itemCols != null) return null;
    return twoUpFits ? 2 : 1;
  }, [gridMode, pinnedCols, customGrid, gridPrefs.itemCols, twoUpFits]);

  const gridStyle = useMemo<React.CSSProperties | undefined>(() => {
    // The default (auto/auto/auto) grid at three or more tiles. Its rows used
    // to be left implicit, which meant
    // `auto`: every row sized to the tile's own floor and stayed there.
    // Growing the window then bought nothing but dead space below the last row,
    // because nothing ever asked the rows to take it. Same track as the custom
    // grid's auto height below, and for the same reason: rows share the pane
    // when they fit, and hold the legible floor and scroll when they don't.
    // The default grid. Its columns used to be a Tailwind class
    // (`grid-cols-1 lg:grid-cols-2`) and so a media query on the *window*,
    // which could not see the pane it was actually laying out. They are inline
    // now, off the same measurement `effectiveCols` reports, so the tracks and
    // the short-row fill can never be told different things.
    if (!customGrid) {
      if (!gridMode) return undefined;
      // One terminal fills the pane and two split it, whatever any Grid setting
      // says: those are the two cases where the point is to see one or two
      // machines as large as the pane allows. Two stack when the pane cannot
      // hold them side by side, or when the top/bottom flip asks for it.
      if (gridCount <= 1) {
        return { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "minmax(0, 1fr)" };
      }
      if (gridCount === 2) {
        return twoUpSplit === "cols" && twoUpFits
          ? { gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridTemplateRows: "minmax(0, 1fr)" }
          : { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: "repeat(2, minmax(0, 1fr))" };
      }
      return {
        gridTemplateColumns: `repeat(${effectiveCols ?? 1}, minmax(0, 1fr))`,
        gridAutoRows: `minmax(${tileMinH}px, 1fr)`,
      };
    }
    const style: React.CSSProperties = {};
    const widthPx =
      gridPrefs.itemCols != null
        ? Math.round(gridPrefs.itemCols * cell.cellW) + TILE_BORDER_X
        : null;
    const floorPx = Math.round(GRID_FLOOR_COLS * cell.cellW) + TILE_BORDER_X;
    if (pinnedCols != null && widthPx != null) {
      style.gridTemplateColumns = `repeat(${pinnedCols}, ${widthPx}px)`;
    } else if (pinnedCols != null) {
      style.gridTemplateColumns = `repeat(${pinnedCols}, minmax(${floorPx}px, 1fr))`;
    } else if (widthPx != null) {
      style.gridTemplateColumns = `repeat(auto-fill, ${widthPx}px)`;
    } else {
      // Only rows pinned, so the columns are the default grid's: measured, not
      // a media query, for the same reason as above.
      style.gridTemplateColumns = `repeat(${effectiveCols ?? 1}, minmax(0, 1fr))`;
    }
    if (gridPrefs.itemRows != null) {
      style.gridAutoRows = `${
        Math.round(gridPrefs.itemRows * cell.cellH) + headerH + TILE_BORDER_Y
      }px`;
    } else {
      // Item height auto: rows grow to fill the pane (a few tiles leave no dead
      // space in a tall/maximized window) but hold a legible floor, so more tiles
      // than fit overflow to a vertical scroll instead of shrinking to slivers.
      style.gridAutoRows = `minmax(${tileMinH}px, 1fr)`;
    }
    return style;
  }, [
    customGrid,
    gridMode,
    gridCount,
    gridPrefs,
    pinnedCols,
    effectiveCols,
    twoUpSplit,
    twoUpFits,
    cell,
    headerH,
    tileMinH,
  ]);

  // Where each tile sits in the laid-out order. `displayIndex` is a position in
  // the tab strip and skips nothing, but a tile hidden from the grid is
  // `display: none` and claims no cell, so the slots the CSS grid fills are the
  // visible tiles renumbered from zero. The fill maths below counts in slots.
  const gridSlot = useMemo(() => {
    const m = new Map<string, number>();
    [...gridTiles]
      .sort((a, b) => (displayIndex.get(a.id) ?? 0) - (displayIndex.get(b.id) ?? 0))
      .forEach((s, i) => m.set(s.id, i));
    return m;
  }, [gridTiles, displayIndex]);

  // Filling a last row that isn't full. Three tiles in two columns leaves a
  // tile-shaped hole at the bottom right, and this is what goes in it.
  //
  //  stretch:  the tiles on the short row widen to share the whole width. The
  //            leftmost takes the odd column when it doesn't divide evenly.
  //  tall:     the tile *above* the gap grows down into it, giving a
  //            full-height tile in the last column. Only when exactly one space
  //            is left: with a wider gap there is no single tile above it, so
  //            it falls back to stretching.
  //  gaps:     nothing. Every tile keeps its own cell.
  //
  // Placement is left to CSS grid's own auto-flow, which follows the `order`
  // the tiles carry. A tall tile occupies its second row before the short row
  // is reached, so the tiles after it fill in beside it without being told to.
  //
  // Both fills make a tile a different size from its neighbours, so neither is
  // allowed to argue with a size you pinned (D4): a stretched tile is wider
  // than the item width, a tall one is taller than the item height. Where the
  // dimension is set by hand, the gap stays; what you asked for wins.
  const spanCols = gridPrefs.itemCols == null;
  const spanRows = gridPrefs.itemRows == null;
  const tileSpan = useCallback(
    (slot: number): React.CSSProperties | undefined => {
      if (rowFill === "gaps") return undefined;
      const cols = effectiveCols;
      if (cols == null || cols < 2 || gridCount <= cols) return undefined;
      const rows = Math.ceil(gridCount / cols);
      const lastRowStart = (rows - 1) * cols;
      const lastRowCount = gridCount - lastRowStart;
      const gap = cols - lastRowCount;
      if (gap <= 0) return undefined;

      if (rowFill === "tall" && gap === 1) {
        // The tile directly above the hole: the last one on the row before.
        return spanRows && slot === lastRowStart - 1
          ? { gridRow: "span 2" }
          : undefined;
      }

      if (!spanCols || slot < lastRowStart) return undefined;
      // Share `cols` columns between `lastRowCount` tiles, the remainder going
      // to the leftmost ones so the row ends flush.
      const nth = slot - lastRowStart;
      const span =
        Math.floor(cols / lastRowCount) + (nth < cols % lastRowCount ? 1 : 0);
      return span > 1 ? { gridColumn: `span ${span}` } : undefined;
    },
    [rowFill, effectiveCols, gridCount, spanCols, spanRows],
  );

  return {
    layout,
    chooseLayout,
    gridMode,
    paneOrder,
    gridTiles,
    gridCount,
    displayIndex,
    excludedFromGrid,
    toggleGridExcluded,
    clearGridExcluded,
    hideGridHeaders,
    toggleGridHeaders,
    twoUpSplit,
    toggleTwoUpSplit,
    gridPrefs,
    setDragCols,
    setDragRows,
    resetTileSize,
    cell,
    headerH,
    tileMinH,
    strictGrid,
    gridSlot,
    effectiveCols,
    tileSpan,
    customGrid,
    gridStyle,
  };
}
