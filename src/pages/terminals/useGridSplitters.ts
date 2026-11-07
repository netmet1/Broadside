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
 *
 * **The gap between tiles** is part of the line too. The strips sit inside
 * the tiles (a tile clips what overflows it), so on their own they are a few
 * pixels either side of a gap that does nothing, and a press aimed at the
 * line you can see lands in the gap. `gapProps` goes on the grid itself: a
 * press there takes the nearest strip's line, and hovering there lights it.
 *
 * **Past the bottom:** while a row is dragged into the bottom of a grid that
 * scrolls, the grid scrolls with it, so a tall row takes one drag.
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
  | {
      axis: "rows";
      index: number;
      rows: number[];
      start: number;
      /** What scrolls the grid, and how far it was scrolled at the start:
       * scrolling during the drag counts as moving the pointer. */
      scroller: HTMLElement | null;
      scroll0: number;
    }
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

/** How far from a strip a press in the gap still counts as on it: the gap
 * itself, plus a little. */
const GAP_REACH_PX = 10;
/** The band at the bottom of a scrolling grid that scrolls it during a row
 * drag, and how fast it goes, in px a second: slow at the top of the band,
 * up to the fastest at its bottom edge and beyond. By the clock, not by the
 * frame, so a 144Hz screen scrolls no faster than a 60Hz one. */
const EDGE_BAND_PX = 24;
const EDGE_SLOW_PX_S = 150;
const EDGE_FAST_PX_S = 600;

/** The element that scrolls the grid: the grid itself on the Terminals tab,
 * the pane around it in the Templates editor. No further up: past that is
 * the app's own page scroll, which a row drag has no business moving. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (const n of [el, el.parentElement]) {
    const o = n ? getComputedStyle(n).overflowY : "";
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

/** The strip nearest a point in the grid's gap, within reach, or null. A
 * strip carries its line in `data-split`. */
function stripNear(grid: HTMLElement, x: number, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestD = GAP_REACH_PX;
  for (const el of grid.querySelectorAll<HTMLElement>("[data-split]")) {
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    if (d <= bestD) {
      best = el;
      bestD = d;
    }
  }
  return best;
}

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
  /** The strip lit from the gap, so it can be put out again. */
  const lit = useRef<HTMLElement | null>(null);

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
        const scroller = fitRows ? null : scrollerOf(grid);
        d = {
          axis: "rows",
          index: line.index,
          rows,
          start: e.clientY,
          scroller,
          scroll0: scroller?.scrollTop ?? 0,
        };
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

    let lastY = 0;
    let frame = 0;
    let lastT = 0;

    const rowsTo = (d: Extract<Drag, { axis: "rows" }>, y: number) => {
      const a = d.rows[d.index]!;
      const scrolled = (d.scroller?.scrollTop ?? 0) - d.scroll0;
      let step = Math.round((y - d.start + scrolled) / cell.cellH) * cell.cellH;
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
    };

    // Held in the band at the bottom of a grid that scrolls, the drag keeps
    // going: scroll a little, then size the row as if the pointer had moved
    // that far. The row grows, which makes room for the next scroll.
    const edgeScroll = (t: number) => {
      frame = 0;
      const d = drag.current;
      if (!d || d.axis !== "rows" || !d.scroller) return;
      const r = d.scroller.getBoundingClientRect();
      const into = lastY - (r.bottom - EDGE_BAND_PX);
      if (into <= 0) {
        lastT = 0;
        return;
      }
      const dt = lastT ? Math.min(t - lastT, 50) : 16;
      lastT = t;
      const speed = Math.min(
        EDGE_SLOW_PX_S + (into / EDGE_BAND_PX) * (EDGE_FAST_PX_S - EDGE_SLOW_PX_S),
        EDGE_FAST_PX_S,
      );
      const by = Math.max(Math.round((speed * dt) / 1000), 1);
      const before = d.scroller.scrollTop;
      d.scroller.scrollTop = before + by;
      // Nothing left to scroll yet (the grid ends at the row being dragged):
      // grow the row as far as the scroll would have gone, which makes the
      // room for the next frame to scroll into.
      if (d.scroller.scrollTop === before) d.scroll0 -= by;
      rowsTo(d, lastY);
      frame = requestAnimationFrame(edgeScroll);
    };

    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.axis === "rows") {
        lastY = e.clientY;
        rowsTo(d, lastY);
        if (!frame && d.scroller) frame = requestAnimationFrame(edgeScroll);
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
      if (frame) cancelAnimationFrame(frame);
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

  // A press or a hover in the gap between tiles. Only on the grid itself,
  // never bubbled up from a tile, so a press inside a tile is left alone.
  const light = useCallback((el: HTMLElement | null) => {
    if (lit.current === el) return;
    if (lit.current) delete lit.current.dataset.near;
    if (el) el.dataset.near = "";
    lit.current = el;
  }, []);
  const gapProps = {
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
      if (e.button !== 0 || e.target !== e.currentTarget) return;
      const line = stripNear(e.currentTarget, e.clientX, e.clientY)?.dataset
        .split;
      if (!line) return;
      light(null);
      begin(e, JSON.parse(line) as SplitLine);
    },
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => {
      if (drag.current) return;
      const el =
        e.target === e.currentTarget
          ? stripNear(e.currentTarget, e.clientX, e.clientY)
          : null;
      light(el);
      e.currentTarget.style.cursor = !el
        ? ""
        : el.getAttribute("aria-orientation") === "vertical"
          ? "col-resize"
          : "row-resize";
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      light(null);
      e.currentTarget.style.cursor = "";
    },
  };

  return { dragging, begin, gapProps };
}
