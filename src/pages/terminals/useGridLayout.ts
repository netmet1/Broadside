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
  forgetDraggedGridSize,
  isAutoGrid,
  loadGridFitRows,
  loadGridMinHeight,
  loadGridMinWidth,
  loadGridPrefs,
  loadGridStrict,
  loadRowFill,
  saveDraggedGridItemCols,
  saveDraggedGridItemRows,
  saveGridItemCols,
  saveGridItemRows,
  type GridPrefs,
  type RowFill,
} from "@/lib/gridPrefs";
import {
  GRID_FLOOR_COLS,
  GRID_SPLIT_MIN_ROWS,
  TILE_BORDER_X,
  TILE_BORDER_Y,
  fitsTwoUp,
  flowGridStyle,
  flowLayout,
  flowPlace,
  flowRowTracks,
  gridHeaderH,
  linesToPx,
  tileSpan as tileSpanFor,
  twoUpThresholdPx,
  type Flow,
  type GridSizes,
} from "@/lib/gridShape";
import { measureTerminalCell } from "@/lib/terminalCell";
import { useUiPrefs } from "@/lib/uiPrefs";
import type { TermSession } from "@/pages/terminals/session";

const LAYOUT_KEY = "terminal-layout";
/** Grid tile chrome: "1" hides every tile's title bar. Persisted so the cleaner
 * look survives a restart. */
const GRID_HIDE_HEADERS_KEY = "terminal-grid-hide-headers";
/** Whether grid tiles resize together ("1", the default and the behaviour
 * before this setting existed) or by the lines between them ("0"). */
const GRID_LOCKED_KEY = "terminal-grid-locked";

/* The tile geometry these two use (minimum widths, the border allowance, the
 * two-up threshold and the hysteresis on it) lives in lib/gridShape, because
 * the Templates editor draws a preview of the same grid and a second copy of
 * this arithmetic would eventually disagree with this one. Re-exported here so
 * useGridResize, which converts a dragged pixel size back into characters, has
 * not had to learn a new import. */
export { TILE_BORDER_X, TILE_BORDER_Y };


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
  /** Tiles the grid actually lays out (creation order, with the tiles hidden
   * from the grid and the kinds hidden by the Filter removed). */
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
   * the grid back to tiles that fit the window. Clears every tile's own size
   * too. */
  resetTileSize: () => void;

  /** True (the default): dragging one tile resizes them all. False: a drag
   * moves the line between two rows or tiles. Remembered across restarts. */
  lockedTiles: boolean;
  /** Flip `lockedTiles`. Unticking also drops a tile size that came from a
   * drag (see the hook), and returns what Settings -> Grid still pins after
   * that, so the caller can say why the lines between tiles are not there.
   * Null when nothing is pinned, and always null when ticking. */
  toggleLockedTiles: () => GridPrefs | null;
  /** The lines between tiles are what a drag moves: unlocked, on the default
   * grid (nothing pinned in Settings), with two or more tiles. */
  splitGrid: boolean;
  /** The shown workspace's own sizes are in force (see GridSizes). */
  hasSizes: boolean;
  /** How the default grid lays its tiles out, by slot; null while a grid
   * pinned in Settings (or Tabs) is showing. */
  flow: Flow | null;
  /** The grid's tiles by slot: the session id in each. */
  slotIds: string[];
  /** Settings -> Grid's minimum tile width, as a fraction of the grid. */
  minWidth: number;
  /** Settings -> Grid's "Fit rows to the window": a row line trades height
   * between two rows (true) rather than setting one row's height and letting
   * the grid scroll (false, the default). */
  fitRows: boolean;
  /** Measured cell size for the current terminal font, for char <-> px maths. */
  cell: { cellW: number; cellH: number };
  /** A tile's title bar in px, for the char <-> px maths that has to allow for
   * it. Zero when the titles are hidden, and it grows with the app font. */
  headerH: number;
  /** A tile's legible minimum height in px. The row track's floor and the tile's
   * own `min-height` are handed this same number (`tileFloorH` while the
   * workspace's own sizes are in force), so they cannot disagree. */
  tileMinH: number;
  /** How short a row may be dragged with the tiles unlocked, in px. */
  splitMinH: number;
  /** The floor actually in force for a tile of the default grid: `splitMinH`
   * once the lines have been dragged, `tileMinH` otherwise. */
  tileFloorH: number;

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
  /** Where the tile in slot `n` goes. On the default grid, its row and columns
   * in the flow; on a grid pinned in Settings, the span that fills a short
   * last row per the Grid setting, or `undefined` for its own cell. */
  tileSpan: (slot: number) => React.CSSProperties | undefined;

  /** A settings-driven uniform grid is in force (see the note on the exception
   * at two tiles). */
  customGrid: boolean;
  gridStyle: React.CSSProperties | undefined;
};

export function useGridLayout({
  sessions,
  filteredOut,
  visible,
  maximized,
  paneRef,
  sizes,
  clearSizes,
}: {
  sessions: TermSession[];
  /** Sessions the View menu's Filter is hiding. They claim no tile, exactly as
   * a tab hidden from the grid does, so the count, the slots and the short-row
   * fill all agree with what is on screen and the grid has no holes. */
  filteredOut: ReadonlySet<string>;
  visible: boolean;
  maximized: boolean;
  /** The element the tiles are laid out in. Measured rather than assumed: how
   * much room the grid has is not the window's width, it is what the sidebar
   * and the broadcast rail have left of it. */
  paneRef: React.RefObject<HTMLDivElement | null>;
  /** The shown workspace's sizes, or null for an even split. */
  sizes: GridSizes | null;
  /** Put the shown workspace's sizes back to even (Reset grid). */
  clearSizes: () => void;
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
  // Guarded on the outcome: the very same set comes back unless something was
  // actually dropped, so the write cannot repeat and a render-phase update
  // cannot loop.
  const liveExcluded = (() => {
    if (excludedFromGrid.size === 0) return excludedFromGrid;
    const live = new Set(sessions.map((s) => s.id));
    const next = new Set([...excludedFromGrid].filter((id) => live.has(id)));
    return next.size === excludedFromGrid.size ? excludedFromGrid : next;
  })();
  if (liveExcluded !== excludedFromGrid) setExcludedFromGrid(liveExcluded);

  const gridTiles = useMemo(
    () =>
      paneOrder.filter(
        (s) => !excludedFromGrid.has(s.id) && !filteredOut.has(s.id),
      ),
    [paneOrder, excludedFromGrid, filteredOut],
  );
  // How many tiles the grid shows, drives the fill/split/scroll layout (B3).
  // Excluded and filtered panes don't count, so hiding one of three tiles gives
  // the real two-up split rather than a two-up-shaped hole.
  const gridCount = gridTiles.length;

  // Grid layout prefs (Settings -> Grid): pinned column count and character-based
  // tile size, or auto. Re-read whenever the page is shown so a change made in
  // Settings (this page stays mounted) takes effect on return, like disabledShells.
  const [savedPrefs, setSavedPrefs] = useState<GridPrefs>(loadGridPrefs);
  const [strictGrid, setStrictGrid] = useState<boolean>(loadGridStrict);
  const [rowFill, setRowFill] = useState<RowFill>(loadRowFill);
  const [minWidthPct, setMinWidthPct] = useState<number>(loadGridMinWidth);
  const [minHeightLines, setMinHeightLines] = useState<number>(loadGridMinHeight);
  const [fitRows, setFitRows] = useState<boolean>(loadGridFitRows);
  const reloadPrefs = useCallback(() => {
    setSavedPrefs(loadGridPrefs());
    setStrictGrid(loadGridStrict());
    setRowFill(loadRowFill());
    setMinWidthPct(loadGridMinWidth());
    setMinHeightLines(loadGridMinHeight());
    setFitRows(loadGridFitRows());
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
  // And how tall, for the even share a new row gets once the rows have
  // heights of their own (see flowRowTracks).
  const [paneH, setPaneH] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => {
      setPaneW(el.clientWidth);
      setPaneH(el.clientHeight);
    };
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
      if (!strictGrid) saveDraggedGridItemCols(cols);
    },
    [strictGrid],
  );
  const setDragRows = useCallback(
    (rows: number) => {
      setDragSize((s) => (s.rows === rows ? s : { ...s, rows }));
      if (!strictGrid) saveDraggedGridItemRows(rows);
    },
    [strictGrid],
  );
  // Unlocked, a drag moves the line between two tiles instead (see
  // useGridSplitters). Those sizes belong to the workspace, not this hook. The
  // lock itself is a preference, so it is remembered.
  //
  // Tracks are rows and tile widths now, not columns: a wide tile can push its
  // neighbour onto the next row, so two rows need not share their lines.
  const [lockedTiles, setLockedTiles] = useState(
    () => localStorage.getItem(GRID_LOCKED_KEY) !== "0",
  );
  //
  // A tile size dragged with the tiles locked pins the whole grid (it is what
  // `customGrid` below tests), and a pinned grid has no lines to drag. So
  // unticking drops that size: this session's, and with Strict off the copy
  // the drag wrote into Settings too, unless a value has been typed there
  // since. A size typed in Settings is left alone; the caller is told it is
  // there instead.
  const toggleLockedTiles = useCallback((): GridPrefs | null => {
    const next = !lockedTiles;
    setLockedTiles(next);
    localStorage.setItem(GRID_LOCKED_KEY, next ? "1" : "0");
    if (next) return null;
    setDragSize({ cols: null, rows: null });
    forgetDraggedGridSize();
    const left = loadGridPrefs();
    setSavedPrefs(left);
    return isAutoGrid(left) ? null : left;
  }, [lockedTiles]);
  // Reset size means "tiles that fit the window", so it has to clear the
  // dragged size, any size pinned in Settings, and the shown workspace's own
  // sizes, or the button would appear to do nothing for someone who set one
  // of them.
  const resetTileSize = useCallback(() => {
    clearSizes();
    setDragSize({ cols: null, rows: null });
    saveGridItemCols(null);
    saveGridItemRows(null);
    reloadPrefs();
  }, [reloadPrefs, clearSizes]);

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
    Math.round(minHeightLines * cell.cellH) + headerH + TILE_BORDER_Y;
  const splitMinH =
    Math.round(GRID_SPLIT_MIN_ROWS * cell.cellH) + headerH + TILE_BORDER_Y;
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
  const twoUpThreshold = twoUpThresholdPx(cell.cellW, gapPx);
  // Adjusted during render rather than in an effect: the pane's measured width
  // arrives from a ResizeObserver, and deciding the column count a frame later
  // means laying the grid out once at the old count and then again, which is a
  // visible flash of two-up before it drops to one. The hysteresis is what
  // stops it oscillating when dropping a column removes the pane's scrollbar
  // and widens the content box back over the threshold.
  //
  // The verdict is computed first and the state is only written when it has
  // actually changed. That guard is not an optimization, it is the difference
  // between working and an infinite render loop: React's bail-out on an
  // unchanged value applies to updates dispatched *outside* render, and a
  // render-phase dispatch instead re-runs the component unconditionally, caps
  // at 25 passes and throws "Too many re-renders". A functional updater that
  // returns the same boolean does not save you; it is never consulted in time.
  const wantsTwoUp = fitsTwoUp(paneW, twoUpThreshold, twoUpFits);
  if (paneW !== 0 && wantsTwoUp !== twoUpFits) setTwoUpFits(wantsTwoUp);

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

  // Where each tile sits in the laid-out order. `displayIndex` is a position in
  // the tab strip and skips nothing, but a tile hidden from the grid is
  // `display: none` and claims no cell, so the slots the grid fills are the
  // visible tiles renumbered from zero. The fill maths below counts in slots.
  const slotIds = useMemo(
    () =>
      [...gridTiles]
        .sort(
          (a, b) => (displayIndex.get(a.id) ?? 0) - (displayIndex.get(b.id) ?? 0),
        )
        .map((s) => s.id),
    [gridTiles, displayIndex],
  );
  const gridSlot = useMemo(() => {
    const m = new Map<string, number>();
    slotIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [slotIds]);

  // The default grid, as rows of tiles (see lib/gridShape's flowLayout): one
  // tile fills the pane, two split it (side by side unless flipped or the pane
  // is too narrow), and three or more go `effectiveCols` to a row. The shown
  // workspace's widths and row heights apply only here, since a size pinned in
  // Settings (or dragged with the tiles locked) is the last word on a pinned
  // grid.
  const minWidth = minWidthPct / 100;
  const flowCols =
    gridCount <= 1
      ? 1
      : gridCount === 2
        ? twoUpSplit === "cols" && twoUpFits
          ? 2
          : 1
        : (effectiveCols ?? 1);
  const flow = useMemo<Flow | null>(
    () =>
      gridMode && !customGrid
        ? flowLayout({
            widths: slotIds.map((id) => sizes?.widths[id] ?? null),
            cols: flowCols,
            min: minWidth,
            rowFill,
          })
        : null,
    [gridMode, customGrid, slotIds, sizes, flowCols, minWidth, rowFill],
  );
  const hasSizes =
    flow !== null &&
    sizes !== null &&
    (sizes.heights.length > 0 ||
      (sizes.rows?.length ?? 0) > 0 ||
      slotIds.some((id) => id in sizes.widths));
  const tileFloorH = hasSizes ? splitMinH : tileMinH;
  const splitGrid = gridMode && !lockedTiles && !customGrid && gridCount >= 2;

  const gridStyle = useMemo<React.CSSProperties | undefined>(() => {
    // The default (auto/auto/auto) grid. Its columns used to be a Tailwind class
    // (`grid-cols-1 lg:grid-cols-2`) and so a media query on the *window*, which
    // could not see the pane it was actually laying out. They come off the same
    // measurement `effectiveCols` reports, so the tracks and the short-row fill
    // can never be told different things.
    //
    // The tracks themselves are in lib/gridShape, along with the short-row fill
    // below, so the Templates editor's preview of a launch is laid out by the
    // same arithmetic as the launch.
    if (!customGrid) {
      if (!flow) return undefined;
      const chrome = headerH + TILE_BORDER_Y;
      const minPx = gridCount <= 2 ? 0 : tileFloorH;
      // The pane less its padding (`p-2`, the same rem as the gap) and the
      // gaps between the rows.
      const inner = paneH - 2 * gapPx - (flow.rows - 1) * gapPx;
      return flowGridStyle(
        flow,
        flowRowTracks({
          n: flow.rows,
          heightsPx: (sizes?.heights ?? []).map((l) =>
            linesToPx(l, cell.cellH, chrome),
          ),
          rows: sizes?.rows,
          fit: fitRows,
          minPx,
          newMinPx: gridCount <= 2 ? 0 : tileMinH,
          evenPx: inner / Math.max(flow.rows, 1),
        }),
      );
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
    flow,
    sizes,
    fitRows,
    paneH,
    gapPx,
    customGrid,
    gridCount,
    gridPrefs,
    pinnedCols,
    effectiveCols,
    cell,
    headerH,
    tileMinH,
    tileFloorH,
  ]);

  // Filling a last row that isn't full: see lib/gridShape's `tileSpan`, which
  // is where the three fills and their reasoning live. The two flags below are
  // this hook's contribution to it, and say the same thing twice on two axes: a
  // dimension the operator pinned by hand is not one the fill may stretch (D4).
  const spanCols = gridPrefs.itemCols == null;
  const spanRows = gridPrefs.itemRows == null;
  const tileSpan = useCallback(
    (slot: number): React.CSSProperties | undefined =>
      flow
        ? flowPlace(flow, slot)
        : tileSpanFor({
            slot,
            count: gridCount,
            cols: effectiveCols,
            rowFill,
            spanCols,
            spanRows,
          }),
    [flow, rowFill, effectiveCols, gridCount, spanCols, spanRows],
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
    lockedTiles,
    toggleLockedTiles,
    splitGrid,
    hasSizes,
    flow,
    slotIds,
    minWidth,
    fitRows,
    cell,
    headerH,
    tileMinH,
    splitMinH,
    tileFloorH,
    strictGrid,
    gridSlot,
    effectiveCols,
    tileSpan,
    customGrid,
    gridStyle,
  };
}
