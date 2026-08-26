import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import {
  GRID_PREFS_EVENT,
  loadGridPrefs,
  loadRowFill,
  type RowFill,
} from "@/lib/gridPrefs";
import { defaultGridStyle, fitsTwoUp, tileSpan, twoUpThresholdPx } from "@/lib/gridShape";
import { measureTerminalCell } from "@/lib/terminalCell";
import { useHint } from "@/lib/status";
import type { TemplateItem } from "@/lib/tauri/templates";
import { MAX_TEMPLATE_ITEMS } from "@/lib/tauri/templates";
import { useUiPrefs } from "@/lib/uiPrefs";
import { cn } from "@/lib/utils";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";
import { DRAG_BOX_PREFIX, parseDrag } from "@/pages/templates/drag";
import { itemKey, resolveItem, type ItemSources } from "@/pages/templates/items";

/** How short a preview box may get. Not the terminal grid's own floor, which is
 * thirteen rows of the terminal font and would make a nine-box template scroll:
 * a preview is about *where the boxes are*, not how much text fits in one, so it
 * trades the real height for showing the whole arrangement at once. */
const PREVIEW_TILE_MIN_H = 84;

const ROW_FILL_WORDS: Record<RowFill, string> = {
  stretch: "the last row stretches to fill the width",
  tall: "the tile above the gap grows down into it",
  gaps: "the gap is left as it is",
};

/**
 * What launching this template will build, drawn from the operator's own Grid
 * settings and used as the place to drop sessions into.
 *
 * **The arrangement is not a picture.** Column count and short-row fill come
 * from `lib/gridPrefs` and the layout from `lib/gridShape`, which is the same
 * arithmetic the Terminals grid lays itself out with. An operator whose Grid
 * settings say three columns sees three columns here; one who has row fill on
 * `tall` sees the tall tile. A fixed illustration would be right for whoever
 * drew it and quietly wrong for everybody else.
 *
 * The trailing `+` box is part of the grid rather than a button beside it,
 * because where the next session lands is the thing you want to see before you
 * drop it. It means the canvas shows one more box than the template holds,
 * which is why the line underneath says plainly how many sessions will open.
 */
export function TemplateCanvas({
  items,
  sources,
  onInsert,
  onMove,
  onRemove,
  onOpenGridSettings,
}: {
  items: TemplateItem[];
  sources: ItemSources;
  /** Add `item` at `index`, pushing what is there along. */
  onInsert: (item: TemplateItem, index: number) => void;
  /** Reorder: the box at `from` lands at `to`. */
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onOpenGridSettings?: () => void;
}) {
  const hint = useHint();
  const { prefs: uiPrefs } = useUiPrefs();

  // The Grid settings, live: Settings and this page can both be mounted, so a
  // column count changed there has to arrive here without a restart. Same
  // event the Terminals grid listens on.
  const [gridPrefs, setGridPrefs] = useState(loadGridPrefs);
  const [rowFill, setRowFill] = useState<RowFill>(loadRowFill);
  useEffect(() => {
    const reload = () => {
      setGridPrefs(loadGridPrefs());
      setRowFill(loadRowFill());
    };
    window.addEventListener(GRID_PREFS_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(GRID_PREFS_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  // How wide this pane is, so the one-or-two-column question is answered the
  // same way the Terminals grid answers it: by measuring, not by a media query
  // on the window. This canvas sits in the same place that grid does (the main
  // area, less a rail of its own), so the measurement means the same thing.
  const paneRef = useRef<HTMLDivElement>(null);
  const [paneW, setPaneW] = useState(0);
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setPaneW(entry.contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cell = useMemo(
    () =>
      measureTerminalCell(uiPrefs.terminalFontFamily, uiPrefs.terminalFontSize),
    [uiPrefs.terminalFontFamily, uiPrefs.terminalFontSize],
  );
  const gapPx = Math.round(0.5 * uiPrefs.appFontSize);
  const threshold = twoUpThresholdPx(cell.cellW, gapPx);
  const [twoUpFits, setTwoUpFits] = useState(true);
  // Adjusted during render, and only when the answer has actually changed, for
  // the reason useGridLayout sets out at length: deciding a frame later means a
  // visible flash of the old column count, and a render-phase dispatch that is
  // not guarded is an infinite loop rather than a wasted render.
  const wantsTwoUp = fitsTwoUp(paneW, threshold, twoUpFits);
  if (paneW !== 0 && wantsTwoUp !== twoUpFits) setTwoUpFits(wantsTwoUp);

  const full = items.length >= MAX_TEMPLATE_ITEMS;
  // The boxes actually drawn: the template, plus the empty one the next session
  // goes in. A full template has nowhere for that to be, so it loses it.
  const boxCount = full ? items.length : items.length + 1;
  const cols =
    gridPrefs.cols != null
      ? Math.min(gridPrefs.cols, Math.max(boxCount, 1))
      : twoUpFits
        ? 2
        : 1;

  const gridStyle = defaultGridStyle({
    count: boxCount,
    cols,
    // A template stores no layout, so there is nothing here that could ask for
    // the top/bottom flip: two sessions get the grid's own default, side by
    // side where the pane is wide enough for it.
    twoUpSplit: "cols",
    twoUpFits,
    tileMinH: PREVIEW_TILE_MIN_H,
  });

  // Which box the pointer is currently over, so a drop has somewhere visible
  // to land. Null when the drag is elsewhere or there is none.
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const handleDrop = (raw: string, index: number) => {
    const payload = parseDrag(raw, sources);
    setOverIndex(null);
    setDragIndex(null);
    if (!payload) return;
    if (payload.kind === "rail") {
      if (full) return;
      onInsert(payload.item, index);
      return;
    }
    // A box dropped on the trailing empty one means "send this to the end",
    // which is one past the last real index.
    onMove(payload.index, Math.min(index, items.length - 1));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={paneRef} className="min-h-0 flex-1 overflow-auto p-2">
        <div className="grid h-full min-h-0 gap-2" style={gridStyle}>
          {items.map((item, i) => {
            const r = resolveItem(item, sources);
            const span = tileSpan({
              slot: i,
              count: boxCount,
              cols,
              rowFill,
              spanCols: true,
              spanRows: true,
            });
            return (
              <div
                key={itemKey(item, i)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", `${DRAG_BOX_PREFIX}${i}`);
                  setDragIndex(i);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = dragIndex === null ? "copy" : "move";
                  setOverIndex(i);
                }}
                onDragLeave={() => setOverIndex((v) => (v === i ? null : v))}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(e.dataTransfer.getData("text/plain"), i);
                }}
                style={{
                  ...span,
                  ...(r.color
                    ? { backgroundColor: `${r.color}33`, borderColor: r.color }
                    : undefined),
                }}
                className={cn(
                  "group relative flex min-h-0 flex-col items-center justify-center gap-1 rounded-md border px-3 py-2 text-center",
                  r.color ? "border" : "border-border bg-muted/30",
                  r.missing && "border-amber-500/60",
                  dragIndex === i && "opacity-40",
                  overIndex === i && "ring-2 ring-primary",
                )}
                {...hint(
                  `Session ${i + 1} of ${items.length}. Drag it to another box to change the order, or drag a new one on top of it to insert before it.`,
                )}
              >
                <span className="absolute left-2 top-1.5 text-[10px] tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`Remove ${r.label}`}
                  title="Remove from this template"
                  className="absolute right-1 top-1 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
                {r.shellKind === null ? (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: r.color ?? "#6b7280" }}
                  />
                ) : (
                  <LocalShellIcon
                    kind={r.shellKind}
                    className={cn(
                      "h-4 w-4 shrink-0",
                      !r.color && "text-muted-foreground",
                    )}
                    style={r.color ? { color: r.color } : undefined}
                  />
                )}
                <span className="max-w-full truncate text-sm font-medium">
                  {r.label}
                </span>
                {r.missing && (
                  <span className="flex items-start gap-1 text-[11px] leading-tight text-amber-600 dark:text-amber-400">
                    <TriangleAlertIcon className="mt-px h-3 w-3 shrink-0" />
                    <span>{r.missing}</span>
                  </span>
                )}
              </div>
            );
          })}

          {!full && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = dragIndex === null ? "copy" : "move";
                setOverIndex(items.length);
              }}
              onDragLeave={() =>
                setOverIndex((v) => (v === items.length ? null : v))
              }
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(e.dataTransfer.getData("text/plain"), items.length);
              }}
              style={tileSpan({
                slot: items.length,
                count: boxCount,
                cols,
                rowFill,
                spanCols: true,
                spanRows: true,
              })}
              className={cn(
                "flex min-h-0 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-center text-muted-foreground",
                overIndex === items.length && "border-primary ring-2 ring-primary",
              )}
              {...hint(
                "Drop a host, shell or profile here to add it to the end of this template.",
              )}
            >
              <PlusIcon className="h-5 w-5" />
              <span className="text-xs">Drag a session here</span>
            </div>
          )}
        </div>
      </div>

      {/* What the boxes above will actually do, said in words, because the
          canvas draws one more box than the template holds and because the
          arrangement follows a setting on another tab. */}
      <p className="shrink-0 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
        {items.length === 0
          ? "Empty. Drag a host, a local shell or a saved profile from the left."
          : `Opens ${items.length} ${items.length === 1 ? "session" : "sessions"}, in this order.`}{" "}
        {items.length > 0 && (
          <>
            Your{" "}
            {onOpenGridSettings ? (
              <button
                type="button"
                onClick={onOpenGridSettings}
                className="font-medium text-primary hover:underline"
                {...hint("Open Settings at the Grid section")}
              >
                Grid settings
              </button>
            ) : (
              "Grid settings"
            )}{" "}
            lay them out {cols === 1 ? "in one column" : `${cols} across`}, and
            when the last row is short, {ROW_FILL_WORDS[rowFill]}.
          </>
        )}
      </p>
    </div>
  );
}
