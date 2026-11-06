/**
 * Drag the line between two grid tiles, with the tiles unlocked: the tile on
 * one side grows by what the other gives up, and the grid still fills the
 * pane. A full-width tile under two others keeps its span; dragging its top
 * edge down makes the row above taller and it shorter (prompts135).
 *
 * The grid's rows and columns are CSS tracks in `fr`. A drag starts from the
 * sizes the browser has actually laid out (read back from the computed style,
 * so a track held at its legible floor is measured as it is, not as the `fr`
 * says), moves pixels from one track to its neighbour, and hands the new sizes
 * back as fractions. The step is a whole cell, the same as the locked drag, so
 * the terminals on either side only resize when a row or column is crossed.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { normalizeTracks, type GridTracks } from "@/lib/gridShape";

/** Which line: between row `index` and the next, or column `index` and the
 * next. */
export type SplitLine = { axis: "rows" | "cols"; index: number };

type Drag = SplitLine & {
  rows: number[];
  cols: number[];
  start: number;
};

/** A computed `grid-template-rows/columns`: the used size of every track, in
 * px ("312px 312.5px"). */
function trackPx(value: string): number[] {
  return value
    .trim()
    .split(/\s+/)
    .map((v) => parseFloat(v))
    .filter((v) => Number.isFinite(v));
}

export function useGridSplitters({
  gridRef,
  cell,
  minRowPx,
  minColPx,
  onTracks,
}: {
  /** The element the tiles are laid out in. */
  gridRef: React.RefObject<HTMLDivElement | null>;
  cell: { cellW: number; cellH: number };
  /** The narrowest a row / column may be dragged to, in px. */
  minRowPx: number;
  minColPx: number;
  /** The new sizes, as the drag crosses each cell. */
  onTracks: (tracks: GridTracks) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const lastStep = useRef<number | null>(null);

  const begin = useCallback(
    (e: React.MouseEvent, line: SplitLine) => {
      const grid = gridRef.current;
      if (!grid) return;
      const cs = getComputedStyle(grid);
      const rows = trackPx(cs.gridTemplateRows);
      const cols = trackPx(cs.gridTemplateColumns);
      const sizes = line.axis === "rows" ? rows : cols;
      if (line.index < 0 || line.index + 1 >= sizes.length) return;
      // Don't let the mousedown reach the tile, which would select that
      // terminal, or start a text selection.
      e.preventDefault();
      e.stopPropagation();
      drag.current = {
        ...line,
        rows,
        cols,
        start: line.axis === "rows" ? e.clientY : e.clientX,
      };
      lastStep.current = null;
      setDragging(true);
    },
    [gridRef],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const rowsAxis = d.axis === "rows";
      const unit = rowsAxis ? cell.cellH : cell.cellW;
      const min = rowsAxis ? minRowPx : minColPx;
      const sizes = rowsAxis ? d.rows : d.cols;
      const a = sizes[d.index]!;
      const b = sizes[d.index + 1]!;
      const raw = (rowsAxis ? e.clientY : e.clientX) - d.start;
      // Whole cells, and never past either neighbour's floor. A pair that is
      // already under the floor (a pane too small for both) stays as it is.
      let step = Math.round(raw / unit) * unit;
      step = Math.max(Math.min(step, b - min), min - a);
      if (a + b < 2 * min) step = 0;
      if (step === lastStep.current) return;
      lastStep.current = step;
      const next = [...sizes];
      next[d.index] = a + step;
      next[d.index + 1] = b - step;
      onTracks({
        rows: normalizeTracks(rowsAxis ? next : d.rows),
        cols: normalizeTracks(rowsAxis ? d.cols : next),
      });
    };

    const onUp = () => {
      drag.current = null;
      setDragging(false);
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
  }, [dragging, cell, minRowPx, minColPx, onTracks]);

  return { dragging, begin };
}
