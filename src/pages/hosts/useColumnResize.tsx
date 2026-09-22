import { useCallback, useRef, useState } from "react";

import { MIN_COL_W } from "@/pages/hosts/constants";

/** Drag-to-resize + double-click-to-fit for a table's columns: the Hosts
 * table, and the Profiles table beside it. Widths persist in localStorage
 * under `widthsKey` (across tab switches and restarts); hidden columns take no
 * width. */
export function useColumnResize(
  orderedIds: string[],
  {
    cols,
    widthsKey,
    hiddenCols,
  }: {
    /** Every column with its shipped width. */
    cols: { id: string; w: number }[];
    widthsKey: string;
    hiddenCols: Set<string>;
  },
) {
  // Persisted column widths (drag-to-resize). Survives tab switches + restart.
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const defaults = Object.fromEntries(cols.map((c) => [c.id, c.w]));
    try {
      const saved = JSON.parse(localStorage.getItem(widthsKey) ?? "{}");
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  });
  const tableWidth = cols.filter((c) => !hiddenCols.has(c.id)).reduce(
    (sum, c) => sum + (colWidths[c.id] ?? c.w),
    0,
  );
  const startResize = useCallback(
    (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidths[id];
      const onMove = (me: MouseEvent) => {
        const w = Math.max(MIN_COL_W, startW + me.clientX - startX);
        setColWidths((prev) => ({ ...prev, [id]: w }));
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setColWidths((prev) => {
          localStorage.setItem(widthsKey, JSON.stringify(prev));
          return prev;
        });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [colWidths, widthsKey],
  );

  // Double-click a divider to auto-size the column to its widest cell (H14).
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const measureCanvas = useRef<HTMLCanvasElement | null>(null);
  const autoSizeColumn = useCallback((id: string) => {
    // Against the *rendered* order, not the shipped one: the columns can be
    // dragged into a different order now, and measuring `tr.children` at the
    // shipped index would size a column by whatever happens to be sitting in
    // that position instead.
    const colIndex = orderedIds.indexOf(id);
    const container = tableScrollRef.current;
    if (colIndex < 0 || !container) return;
    const canvas =
      measureCanvas.current ??
      (measureCanvas.current = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let max = 0;
    container.querySelectorAll<HTMLTableRowElement>("tr").forEach((tr) => {
      const cell = tr.children[colIndex] as HTMLElement | undefined;
      const text = cell?.textContent ?? "";
      if (!cell || !text) return;
      const cs = getComputedStyle(cell);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      max = Math.max(max, ctx.measureText(text).width);
    });
    // + cell padding (px-2 each side) + a little slack for the sort arrow.
    const width = Math.max(MIN_COL_W, Math.ceil(max) + 28);
    setColWidths((prev) => {
      const next = { ...prev, [id]: width };
      localStorage.setItem(widthsKey, JSON.stringify(next));
      return next;
    });
  }, [orderedIds, widthsKey]);

  /** A thin drag strip on a column header's right edge. Returns JSX (not a
   * component) so it isn't remounted each render. */
  const resizeHandle = (id: string) => (
    <span
      onMouseDown={(e) => startResize(id, e)}
      onDoubleClick={() => autoSizeColumn(id)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize border-r border-border/70 hover:border-primary hover:bg-primary/20"
      aria-hidden
      data-resize-handle=""
      title="Drag to resize · double-click to fit"
    />
  );

  return {
    colWidths,
    tableWidth,
    tableScrollRef,
    resizeHandle,
  };
}
