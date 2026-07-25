/**
 * Drag a grid tile's edge to set the tile size for the whole grid.
 *
 * The drag writes the same Settings -> Grid preferences the Grid settings
 * section writes (item width in characters, item height in rows), so there is
 * exactly one source of truth: drag a tile and the Settings numbers show what
 * you dragged to, and everything that already falls out of a pinned size
 * (every tile matching, horizontal scroll when they overflow) comes for free.
 *
 * Pixels are converted to characters with the same cell metrics the layout uses
 * in reverse, so a drag lands on whole cells rather than an arbitrary pixel
 * size that `fit` would round away anyway.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  GRID_ITEM_COLS_MAX,
  GRID_ITEM_COLS_MIN,
  GRID_ITEM_ROWS_MAX,
  GRID_ITEM_ROWS_MIN,
  saveGridItemCols,
  saveGridItemRows,
} from "@/lib/gridPrefs";
import {
  GRID_HEADER_H,
  TILE_BORDER_X,
  TILE_BORDER_Y,
} from "@/pages/terminals/useGridLayout";

/** Which edge is being dragged: the right edge sets width, the bottom sets
 * height, and the corner sets both at once. */
export type ResizeAxis = "x" | "y" | "both";

type Drag = {
  axis: ResizeAxis;
  /** Tile size in px when the drag started, plus the pointer position, so the
   * new size tracks the pointer's total travel rather than accumulating
   * per-event deltas (which drift). */
  startW: number;
  startH: number;
  startX: number;
  startY: number;
};

export function useGridResize({
  cell,
  onChange,
}: {
  cell: { cellW: number; cellH: number };
  /** Called after a write so the caller can re-read the prefs and re-render. */
  onChange: () => void;
}) {
  const [resizing, setResizing] = useState(false);
  const drag = useRef<Drag | null>(null);
  // The last values written, so a drag only touches localStorage when the
  // character count actually changes (roughly once per cell crossed) instead of
  // on every mouse move.
  const lastWritten = useRef<{ cols: number | null; rows: number | null }>({
    cols: null,
    rows: null,
  });

  const begin = useCallback(
    (e: React.MouseEvent, axis: ResizeAxis, tile: HTMLElement | null) => {
      if (!tile) return;
      // Don't let the mousedown reach the tile, which would select that
      // terminal, or start a text selection.
      e.preventDefault();
      e.stopPropagation();
      const r = tile.getBoundingClientRect();
      drag.current = {
        axis,
        startW: r.width,
        startH: r.height,
        startX: e.clientX,
        startY: e.clientY,
      };
      lastWritten.current = { cols: null, rows: null };
      setResizing(true);
    },
    [],
  );

  useEffect(() => {
    if (!resizing) return;

    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.axis === "x" || d.axis === "both") {
        const px = d.startW + (e.clientX - d.startX);
        const cols = Math.min(
          GRID_ITEM_COLS_MAX,
          Math.max(
            GRID_ITEM_COLS_MIN,
            Math.round((px - TILE_BORDER_X) / cell.cellW),
          ),
        );
        if (cols !== lastWritten.current.cols) {
          lastWritten.current.cols = cols;
          saveGridItemCols(cols);
          onChange();
        }
      }
      if (d.axis === "y" || d.axis === "both") {
        const px = d.startH + (e.clientY - d.startY);
        const rows = Math.min(
          GRID_ITEM_ROWS_MAX,
          Math.max(
            GRID_ITEM_ROWS_MIN,
            Math.round((px - GRID_HEADER_H - TILE_BORDER_Y) / cell.cellH),
          ),
        );
        if (rows !== lastWritten.current.rows) {
          lastWritten.current.rows = rows;
          saveGridItemRows(rows);
          onChange();
        }
      }
    };

    const onUp = () => {
      drag.current = null;
      setResizing(false);
    };

    // Suppress text selection for the duration, as the sidebar resize does.
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.userSelect = prevSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing, cell, onChange]);

  /** Clear both pinned dimensions, putting the grid back to fit-to-window. */
  const resetSize = useCallback(() => {
    saveGridItemCols(null);
    saveGridItemRows(null);
    onChange();
  }, [onChange]);

  return { resizing, begin, resetSize };
}
