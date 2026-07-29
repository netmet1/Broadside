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
  isAutoGrid,
  loadGridPrefs,
  saveGridItemCols,
  saveGridItemRows,
  type GridPrefs,
} from "@/lib/gridPrefs";
import { measureTerminalCell } from "@/lib/terminalCell";
import { useUiPrefs } from "@/lib/uiPrefs";
import type { TermSession } from "@/pages/terminals/session";

const LAYOUT_KEY = "terminal-layout";
/** Grid tile chrome: "1" hides every tile's title bar. Persisted so the cleaner
 * look survives a restart. */
const GRID_HIDE_HEADERS_KEY = "terminal-grid-hide-headers";

/** Minimum tile width, in characters, when a fixed column count is set but the
 * item width is auto — keeps a big column count from shaving tiles to slivers.
 * Past this the grid overflows and scrolls horizontally instead. */
const GRID_FLOOR_COLS = 24;
/** Per-tile chrome added to the character-derived pixel size: the 1px border on
 * each side (X), and the border plus the grid pane header (Y). Approximate — fit
 * rounds a container to whole cells, so the result lands within ~1 col/row. */
export const TILE_BORDER_X = 2;
export const TILE_BORDER_Y = 2;
export const GRID_HEADER_H = 30;
/** Legible minimum tile height (16rem = 256px) for a custom grid whose item
 * height is auto. Rows fill the pane when few (so a maximized window has no dead
 * space) but never shrink below this, overflowing to a vertical scroll when many. */
const GRID_ROW_FLOOR_PX = 256;

/** How the open terminals are laid out below the tab strip: one pane at a time
 * (the default) or every pane tiled at once, mirroring the skill run panel. */
export type TermLayout = "tabs" | "grid";

export type GridLayout = {
  layout: TermLayout;
  chooseLayout: (next: TermLayout) => void;
  /** Grid is actually showing: the layout is grid AND nothing is maximized. */
  gridMode: boolean;

  /** Panes in stable creation order — the DOM order they are rendered in. */
  paneOrder: TermSession[];
  /** Tiles the grid actually lays out (creation order, exclusions removed). */
  gridTiles: TermSession[];
  /** How many tiles the grid shows. Drives the 1 / 2 / 3+ layout. */
  gridCount: number;
  /** Each session's position in the tab strip, for the CSS `order` property. */
  displayIndex: Map<string, number>;

  excludedFromGrid: Set<string>;
  toggleGridExcluded: (id: string) => void;

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

  /** A settings-driven uniform grid is in force (see the note on the exception
   * at two tiles). */
  customGrid: boolean;
  /** Custom, but columns are still auto — a Tailwind class handles those. */
  customColsAuto: boolean;
  gridStyle: React.CSSProperties | undefined;
};

export function useGridLayout({
  sessions,
  visible,
  maximized,
}: {
  sessions: TermSession[];
  visible: boolean;
  maximized: boolean;
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
  // persisted — the page stays mounted for the whole session so the choice
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
  // Drop ids whose session has closed so the set can't grow without bound.
  useEffect(() => {
    setExcludedFromGrid((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(sessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  const gridTiles = useMemo(
    () => paneOrder.filter((s) => !excludedFromGrid.has(s.id)),
    [paneOrder, excludedFromGrid],
  );
  // How many tiles the grid shows — drives the fill/split/scroll layout (B3).
  // Excluded panes don't count, so hiding one of three tiles gives the real
  // two-up split rather than a two-up-shaped hole.
  const gridCount = gridTiles.length;

  // Grid layout prefs (Settings -> Grid): pinned column count and character-based
  // tile size, or auto. Re-read whenever the page is shown so a change made in
  // Settings (this page stays mounted) takes effect on return, like disabledShells.
  const [savedPrefs, setSavedPrefs] = useState<GridPrefs>(loadGridPrefs);
  useEffect(() => {
    if (visible) setSavedPrefs(loadGridPrefs());
  }, [visible]);

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
  const setDragCols = useCallback(
    (cols: number) =>
      setDragSize((s) => (s.cols === cols ? s : { ...s, cols })),
    [],
  );
  const setDragRows = useCallback(
    (rows: number) =>
      setDragSize((s) => (s.rows === rows ? s : { ...s, rows })),
    [],
  );
  // Reset size means "tiles that fit the window", so it has to clear both the
  // dragged size and any size pinned in Settings, or the button would appear to
  // do nothing for someone who set the numbers by hand.
  const resetTileSize = useCallback(() => {
    setDragSize({ cols: null, rows: null });
    saveGridItemCols(null);
    saveGridItemRows(null);
    setSavedPrefs(loadGridPrefs());
  }, []);

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

  // A non-auto grid switches to a uniform, settings-driven layout.
  //
  // One and two tiles are the deliberate exceptions: a single terminal fills the
  // whole area and two split it (with the top/bottom flip), whatever the Grid
  // settings say. Those are the two cases where the point is to see one or two
  // machines as large as the window allows, so a pinned column count or tile
  // size can only get in the way: three columns with one terminal open left a
  // third of a screen in use and two thirds empty.
  const customGrid = gridMode && !isAutoGrid(gridPrefs) && gridCount > 2;
  // When custom but neither cols nor item width is pinned (only rows), columns
  // fall back to the shipped responsive default via a class, not inline style.
  const customColsAuto =
    customGrid && gridPrefs.cols == null && gridPrefs.itemCols == null;

  const gridStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!customGrid) return undefined;
    const style: React.CSSProperties = {};
    const widthPx =
      gridPrefs.itemCols != null
        ? Math.round(gridPrefs.itemCols * cell.cellW) + TILE_BORDER_X
        : null;
    const floorPx = Math.round(GRID_FLOOR_COLS * cell.cellW) + TILE_BORDER_X;
    if (gridPrefs.cols != null && widthPx != null) {
      style.gridTemplateColumns = `repeat(${gridPrefs.cols}, ${widthPx}px)`;
    } else if (gridPrefs.cols != null) {
      style.gridTemplateColumns = `repeat(${gridPrefs.cols}, minmax(${floorPx}px, 1fr))`;
    } else if (widthPx != null) {
      style.gridTemplateColumns = `repeat(auto-fill, ${widthPx}px)`;
    }
    // else: columns stay auto (only rows pinned) — a Tailwind class handles it.
    if (gridPrefs.itemRows != null) {
      style.gridAutoRows = `${
        Math.round(gridPrefs.itemRows * cell.cellH) + GRID_HEADER_H + TILE_BORDER_Y
      }px`;
    } else {
      // Item height auto: rows grow to fill the pane (a few tiles leave no dead
      // space in a tall/maximized window) but hold a legible floor, so more tiles
      // than fit overflow to a vertical scroll instead of shrinking to slivers.
      style.gridAutoRows = `minmax(${GRID_ROW_FLOOR_PX}px, 1fr)`;
    }
    return style;
  }, [customGrid, gridPrefs, cell]);

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
    hideGridHeaders,
    toggleGridHeaders,
    twoUpSplit,
    toggleTwoUpSplit,
    gridPrefs,
    setDragCols,
    setDragRows,
    resetTileSize,
    cell,
    customGrid,
    customColsAuto,
    gridStyle,
  };
}
