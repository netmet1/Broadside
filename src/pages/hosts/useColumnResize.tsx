import { useCallback, useRef, useState } from "react";

import { loadHiddenCols } from "@/lib/hostColumns";
import { COLS, COL_WIDTHS_KEY, MIN_COL_W } from "@/pages/hosts/constants";

/** Drag-to-resize + double-click-to-fit for the hosts table columns. Widths
 * persist in localStorage (across tab switches and restarts); `hiddenCols`
 * reflects the latest Settings → Appearance choice (read on mount). */
export function useColumnResize() {
  // Persisted column widths (drag-to-resize). Survives tab switches + restart.
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    const defaults = Object.fromEntries(COLS.map((c) => [c.id, c.w]));
    try {
      const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) ?? "{}");
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  });
  // Columns the user hid from Settings → Appearance (read on mount; the Hosts
  // tab remounts when shown, so it always reflects the latest choice).
  const [hiddenCols] = useState(loadHiddenCols);
  const tableWidth = COLS.filter((c) => !hiddenCols.has(c.id)).reduce(
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
          localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(prev));
          return prev;
        });
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [colWidths],
  );

  // Double-click a divider to auto-size the column to its widest cell (H14).
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const measureCanvas = useRef<HTMLCanvasElement | null>(null);
  const autoSizeColumn = useCallback((id: string) => {
    const colIndex = COLS.findIndex((c) => c.id === id);
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
      localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /** A thin drag strip on a column header's right edge. Returns JSX (not a
   * component) so it isn't remounted each render. */
  const resizeHandle = (id: string) => (
    <span
      onMouseDown={(e) => startResize(id, e)}
      onDoubleClick={() => autoSizeColumn(id)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize border-r border-border/70 hover:border-primary hover:bg-primary/20"
      aria-hidden
      title="Drag to resize · double-click to fit"
    />
  );

  return {
    colWidths,
    hiddenCols,
    tableWidth,
    tableScrollRef,
    resizeHandle,
  };
}
