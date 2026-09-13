import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, SettingsIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { GridFields } from "@/components/GridControls";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  GRID_PREFS_EVENT,
  loadGridPrefs,
  loadRowFill,
  type RowFill,
} from "@/lib/gridPrefs";
import {
  TILE_BORDER_X,
  defaultGridStyle,
  fitsTwoUp,
  tileSpan,
  twoUpThresholdPx,
} from "@/lib/gridShape";
import { useGridFields } from "@/lib/gridFields";
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
 * The `+` band is **outside** the arrangement, a strip of its own under the
 * scrolling pane. It used to be a box in the grid, on the reasoning that where
 * the next session lands is what you want to see before you drop it. But a cell
 * it takes is a cell the arrangement does not have: the canvas laid out one
 * tile too many, and at two columns that got the short-row fill exactly
 * backwards, drawing a fill for the counts that launch without one and hiding
 * it for the counts that launch with one. It was a poor prediction in any case,
 * since adding a session re-lays the whole grid rather than filling in one more
 * square.
 *
 * Out of the grid entirely rather than merely placed on the row beneath it,
 * because a row of the grid is a *tile-sized* row: at three sessions the drop
 * target was taking a third of the canvas to say four words. A strip is the
 * same target in a fraction of the height, it no longer scrolls away under a
 * long arrangement, and there is no arithmetic left that could put it back
 * inside the boxes. The one exception is an empty template, where the band is
 * the whole canvas, because there is no arrangement for it to be under and
 * nothing else for the canvas to be.
 */
export function TemplateCanvas({
  items,
  sources,
  onInsert,
  onMove,
  onRemove,
  onOpenGridSettings,
  visible,
}: {
  items: TemplateItem[];
  sources: ItemSources;
  /** Add `item` at `index`, pushing what is there along. */
  onInsert: (item: TemplateItem, index: number) => void;
  /** Reorder: the box at `from` lands at `to`. */
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  onOpenGridSettings?: () => void;
  /** False while another tab is showing. The page stays mounted, hidden, so an
   * open Grid settings panel has to be shut from here. */
  visible: boolean;
}) {
  const hint = useHint();
  const { prefs: uiPrefs } = useUiPrefs();
  // The same four preferences the arrangement below is drawn from, as controls,
  // for the popover on the line at the foot of the page. Held here rather than
  // inside the popover so it is not rebuilt on every open.
  const gridFields = useGridFields();
  // Whether that popover is open. Held here so it can be shut from outside the
  // popover: by the gear, which leaves the page, and by the page being hidden
  // any other way. Shut during render rather than in an effect, so it is closed
  // in the same commit that hides the page. Left open, it came back open on the
  // next visit, and while away it had no trigger to be placed against.
  const [gridOpen, setGridOpen] = useState(false);
  if (!visible && gridOpen) setGridOpen(false);

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

  // A full template has nowhere to put the `+` box, so it loses it.
  const full = items.length >= MAX_TEMPLATE_ITEMS;
  // What the arrangement is worked out from: the sessions, and only those. The
  // `+` box is drawn as well and sits below them (see the note at the top).
  const count = items.length;

  // How many columns the real grid would use, worked out the way it works it
  // out. A pinned count wins and is trimmed to the number of tiles; a pinned
  // tile *width* means as many as fit, which this pane can answer because it is
  // the same width class as the grid pane; otherwise it is the measured one or
  // two.
  const tileWidthPx =
    gridPrefs.itemCols != null
      ? Math.round(gridPrefs.itemCols * cell.cellW) + TILE_BORDER_X
      : null;
  const cols =
    gridPrefs.cols != null
      ? Math.min(gridPrefs.cols, Math.max(count, 1))
      : tileWidthPx != null && paneW > 0
        ? Math.max(1, Math.floor((paneW + gapPx) / (tileWidthPx + gapPx)))
        : twoUpFits
          ? 2
          : 1;

  // A dimension the operator pinned by hand is not one the short-row fill may
  // stretch (D4), so the gap stays where a size was asked for. Said here as
  // well as in the grid, or the preview would close a hole the real thing
  // leaves open.
  const spanCols = gridPrefs.itemCols == null;
  const spanRows = gridPrefs.itemRows == null;

  const gridStyle = defaultGridStyle({
    count,
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

  // Where a new session is dropped. Two shapes and one behaviour: a strip under
  // the arrangement when there is an arrangement, and the whole canvas when
  // there is not, because an empty template's canvas has nothing else to be and
  // a 26px target is a poor welcome.
  const dropBand = (whole: boolean) => (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = dragIndex === null ? "copy" : "move";
        setOverIndex(items.length);
      }}
      onDragLeave={() => setOverIndex((v) => (v === items.length ? null : v))}
      onDrop={(e) => {
        e.preventDefault();
        handleDrop(e.dataTransfer.getData("text/plain"), items.length);
      }}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-center text-xs text-muted-foreground",
        whole ? "min-h-0 flex-col px-3 py-2" : "mx-2 mb-2 shrink-0 py-1",
        overIndex === items.length && "border-primary ring-2 ring-primary",
      )}
      {...hint(
        "Drop a host, shell or profile here to add it to the end of this template.",
      )}
    >
      <PlusIcon className={whole ? "h-5 w-5" : "h-3.5 w-3.5"} />
      <span>Drag a session here</span>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={paneRef} className="min-h-0 flex-1 overflow-auto p-2">
        <div className="grid h-full min-h-0 gap-2" style={gridStyle}>
          {items.map((item, i) => {
            const r = resolveItem(item, sources);
            const span = tileSpan({
              slot: i,
              count,
              cols,
              rowFill,
              spanCols,
              spanRows,
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
                  {...hint(
                    `Take ${r.label} out of this template. The host, shell or profile itself is untouched.`,
                  )}
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
          {items.length === 0 && dropBand(true)}
        </div>
      </div>

      {/* The strip, once there is an arrangement for it to sit under. Outside
          the pane above, so a long one scrolls under it and it is always where
          you left it. */}
      {items.length > 0 && !full && dropBand(false)}

      {/* What the boxes above will actually do, said in words, because the
          arrangement follows a setting that is not on this template. The
          controls hang off those words: this is the line where you find out the
          layout is not the one you wanted, so it is the line that should change
          it. */}
      <p className="shrink-0 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
        {items.length === 0
          ? "Empty. Drag a host, a local shell or a saved profile from the left."
          : `Opens ${items.length} ${items.length === 1 ? "session" : "sessions"}, in this order.`}{" "}
        {items.length > 0 && (
          <>
            Your{" "}
            <Popover open={gridOpen} onOpenChange={setGridOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  {...hint(
                    "Change the grid these boxes are laid out by, without leaving the page",
                  )}
                >
                  Grid settings
                </button>
              </PopoverTrigger>
              {/* Mounted only while the page is showing. The page stays mounted
                  behind a hidden class, and a panel on a hidden page is drawn
                  against a trigger that is not there: the top-left corner of
                  the window. Closing it is not enough, and neither is
                  hideWhenDetached: the painted frames of build 67-7 showed
                  WebView2 drawing the 100ms fade-out in that corner while the
                  DOM said the panel was hidden. Unmounted in the same commit
                  that hides the page, there is nothing left to draw. */}
              {visible && (
                <PopoverContent side="top" align="start" className="w-80">
                  <p className="mb-3 text-xs text-muted-foreground">
                    Broadside&apos;s Grid settings, the same four the Terminals
                    grid lays itself out by. A template stores no layout of its
                    own, so a change here is a change everywhere.
                  </p>
                  <div className="grid gap-3">
                    <GridFields f={gridFields} compact />
                  </div>
                  {/* The words are a label and only the gear goes anywhere: the
                      same gear the Settings tab wears in the sidebar. */}
                  {onOpenGridSettings && (
                    <div className="mt-3 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <span>Grid Settings</span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => {
                          setGridOpen(false);
                          onOpenGridSettings();
                        }}
                        aria-label="Open Grid Settings"
                        {...hint(
                          "Open the Settings tab at Grid, for Strict and the three defaults",
                        )}
                      >
                        <SettingsIcon />
                      </Button>
                    </div>
                  )}
                </PopoverContent>
              )}
            </Popover>{" "}
            lay them out {cols === 1 ? "in one column" : `${cols} across`}, and
            when the last row is short, {ROW_FILL_WORDS[rowFill]}.
          </>
        )}
      </p>
    </div>
  );
}
