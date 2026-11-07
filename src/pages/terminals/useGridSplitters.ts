/**
 * Drag the lines between grid tiles, with the tiles unlocked.
 *
 * **Rows:** by default the line under a row sets that row's height and
 * nothing else's: the rows below move down, and once the rows are taller than
 * the pane it scrolls. The last row's bottom edge is a line too. With
 * Settings -> Grid's "Fit rows to the window" the line between two rows
 * trades height between them instead, and the grid still fills the pane.
 * Either way a drag starts from the heights the browser has actually laid
 * out (read back from the computed style, so a row held at its floor is
 * measured as it is), and every row's height comes back in lines, so the rows
 * nobody touched keep the height they had.
 *
 * **Tiles side by side:** each row has its own widths (see lib/gridShape's
 * flowLayout), so a drag moves one row's line and no other. Between two tiles,
 * the left one grows by what the right one gives up; once the right one would
 * be left at or under the minimum width it moves down to the next row, and the
 * left one keeps the width it was dragged to, leaving blank space beside it.
 * Dragging back brings it up again. The right edge of a tile
 * with blank space beside it, or alone in its row, sets that tile's width and
 * nothing else's.
 *
 * Either way the step is a whole cell, the same as the locked drag, so the
 * terminals only resize when a row or column is crossed.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Flow, FlowLine } from "@/lib/gridShape";

/** Which line: between row `index` and the next, or a line between tiles. */
export type SplitLine =
  | { axis: "rows"; index: number }
  | { axis: "cols"; line: FlowLine };

/** New widths by slot; null takes a tile's own width away, so it shares what
 * its row has left. */
export type SlotWidths = Map<number, number | null>;

type Drag =
  | { axis: "rows"; index: number; rows: number[]; start: number }
  | {
      axis: "cols";
      line: FlowLine;
      /** The grid's width, gaps left out: what a width's fraction is of. */
      total: number;
      /** The tiles' widths when the drag began, as fractions. */
      a: number;
      b: number;
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

const round = (v: number) => Math.round(v * 10000) / 10000;

export function useGridSplitters({
  gridRef,
  flow,
  cell,
  minRowPx,
  minColPx,
  minWidth,
  fitRows,
  toLines,
  onRows,
  onWidths,
}: {
  /** The element the tiles are laid out in. */
  gridRef: React.RefObject<HTMLDivElement | null>;
  flow: Flow | null;
  cell: { cellW: number; cellH: number };
  /** The shortest a row may be dragged to, in px. */
  minRowPx: number;
  /** The narrowest a tile may be dragged to, in px. */
  minColPx: number;
  /** Settings -> Grid's minimum tile width, as a fraction of the grid. */
  minWidth: number;
  /** Rows always fill the pane: a line trades height between two rows. */
  fitRows: boolean;
  /** A row's height in px as lines of the terminal font. */
  toLines: (px: number) => number;
  /** Every row's height in lines, as the drag crosses each cell. */
  onRows: (heights: number[]) => void;
  /** The new tile widths, as the drag crosses each cell. */
  onWidths: (widths: SlotWidths) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const lastStep = useRef<number | null>(null);

  const begin = useCallback(
    (e: React.MouseEvent, line: SplitLine) => {
      const grid = gridRef.current;
      if (!grid || !flow) return;
      const cs = getComputedStyle(grid);
      let d: Drag;
      if (line.axis === "rows") {
        const rows = trackPx(cs.gridTemplateRows);
        const last = fitRows ? rows.length - 2 : rows.length - 1;
        if (line.index < 0 || line.index > last) return;
        d = { axis: "rows", index: line.index, rows, start: e.clientY };
      } else {
        const total = trackPx(cs.gridTemplateColumns).reduce((a, b) => a + b, 0);
        if (!(total > 0)) return;
        const l = line.line;
        const a = flow.tiles[l.kind === "pair" ? l.left : l.slot]?.w;
        const b = l.kind === "pair" ? flow.tiles[l.right]?.w : 0;
        if (a === undefined || b === undefined) return;
        d = { axis: "cols", line: l, total, a, b, start: e.clientX };
      }
      // Don't let the mousedown reach the tile, which would select that
      // terminal, or start a text selection.
      e.preventDefault();
      e.stopPropagation();
      drag.current = d;
      lastStep.current = null;
      setDragging(true);
    },
    [gridRef, flow, fitRows],
  );

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.axis === "rows") {
        const a = d.rows[d.index]!;
        let step = Math.round((e.clientY - d.start) / cell.cellH) * cell.cellH;
        const next = [...d.rows];
        if (fitRows) {
          // Whole cells, and never past either neighbour's floor. A pair that
          // is already under the floor (a pane too small for both) stays.
          const b = d.rows[d.index + 1]!;
          step = Math.max(Math.min(step, b - minRowPx), minRowPx - a);
          if (a + b < 2 * minRowPx) step = 0;
          next[d.index + 1] = b - step;
        } else {
          step = Math.max(step, Math.min(minRowPx - a, 0));
        }
        if (step === lastStep.current) return;
        lastStep.current = step;
        next[d.index] = a + step;
        onRows(next.map(toLines));
        return;
      }

      // Side to side, in fractions of the grid's width, a whole cell a step.
      const unit = cell.cellW / d.total;
      const floor = Math.min(Math.max(minWidth, minColPx / d.total), 1);
      let step = Math.round((e.clientX - d.start) / d.total / unit) * unit;
      // The left tile never goes under the floor, and nothing goes past the
      // grid's right side.
      step = Math.min(Math.max(step, floor - d.a), 1 - d.a);
      if (step === lastStep.current) return;
      lastStep.current = step;
      const l = d.line;
      if (l.kind === "edge") {
        onWidths(new Map([[l.slot, round(d.a + step)]]));
        return;
      }
      const right = d.b - step;
      onWidths(
        new Map([
          [l.left, round(d.a + step)],
          // At or under the floor, the right tile has no width of its own: it
          // moves down a row and shares that one.
          [l.right, right <= floor + 1e-6 ? null : round(right)],
        ]),
      );
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
  }, [
    dragging,
    cell,
    minRowPx,
    minColPx,
    minWidth,
    fitRows,
    toLines,
    onRows,
    onWidths,
  ]);

  return { dragging, begin };
}
