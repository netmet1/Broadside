import { useEffect, useRef, useState } from "react";
import { PencilIcon, PlusIcon, XIcon } from "lucide-react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PALETTE } from "@/lib/palette";
import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/pages/terminals/useWorkspaces";

type Props = {
  workspaces: Workspace[];
  activeId: string;
  /** Tabs in each workspace, by id. */
  counts: ReadonlyMap<string, number>;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onRecolor: (id: string, color: string) => void;
  /** Asks first when the workspace has tabs; see TerminalsPage. */
  onClose: (id: string) => void;
  /** The tab being dragged on the tab strip, so it can be dropped on a
   * workspace to move it there. */
  draggingTabId: string | null;
  onDropTab: (tabId: string, workspaceId: string) => void;
  /** Move a workspace to where another one is in the row. */
  onReorder: (sourceId: string, targetId: string) => void;
};

/**
 * The row of workspaces above the tab strip. Only drawn with two or more: with
 * one there is nothing to switch between, and the Terminals tab looks exactly
 * as it did before workspaces existed.
 *
 * Click to show a workspace, double-click to rename it, right-click for its
 * colour and Close, drag one along the row to move it. A tab dragged from the
 * strip below can be dropped on one to move it there.
 *
 * More than fit scroll sideways, under the mouse wheel as well as the
 * scrollbar, and the one on screen is scrolled into view when it changes. The
 * "+" sits outside the scrolling part, so it never goes off the end.
 */
export function WorkspaceStrip({
  workspaces,
  activeId,
  counts,
  onSwitch,
  onNew,
  onRename,
  onRecolor,
  onClose,
  draggingTabId,
  onDropTab,
  onReorder,
}: Props) {
  const hint = useHint();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dropOver, setDropOver] = useState<string | null>(null);
  // A workspace being dragged along the row, and the one it is over.
  const [dragWs, setDragWs] = useState<string | null>(null);
  const [dragOverWs, setDragOverWs] = useState<string | null>(null);
  const endWsDrag = () => {
    setDragWs(null);
    setDragOverWs(null);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  /** The name box, and whether Rename was picked from the right-click menu:
   * the menu hands the focus back to the chip as it closes, after the box
   * has taken it, so the box takes it back then. */
  const renameRef = useRef<HTMLInputElement>(null);
  const renameFromMenu = useRef(false);
  const chipRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // A plain wheel scrolls the row sideways. Left to itself it scrolls nothing,
  // since the row only overflows across, and a wheel mouse has no other way to
  // reach the far end short of the scrollbar. A sideways trackpad swipe is
  // already horizontal and is left alone, as is Ctrl+wheel.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // The workspace on screen is always one you can see in the row: switched to
  // from a menu, brought forward by a tab, or just made with the "+". The least
  // scroll that shows it whole, with a little of its neighbour. Not on a
  // reorder, though: the row jumping away under the pointer the moment a
  // workspace is dropped would undo the scrolling that got you there.
  useEffect(() => {
    const c = scrollRef.current;
    const t = chipRefs.current.get(activeId);
    if (!c || !t) return;
    const cr = c.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    if (tr.left >= cr.left && tr.right <= cr.right) return;
    const delta = tr.left < cr.left ? tr.left - cr.left - 16 : tr.right - cr.right + 16;
    c.scrollTo({ left: c.scrollLeft + delta, behavior: "smooth" });
  }, [activeId, workspaces.length]);

  const startRename = (w: Workspace) => {
    setDraft(w.name);
    setRenaming(w.id);
  };
  const commitRename = () => {
    if (renaming) onRename(renaming, draft);
    setRenaming(null);
  };

  return (
    <div className="flex min-w-0 items-center gap-1 pl-1 pr-2 pt-1.5">
    <div
      ref={scrollRef}
      role="tablist"
      aria-label="Workspaces"
      // Padding inside the scrolling box, so a focus or drop ring and the
      // drop bar beside the first chip are not clipped by it.
      className="flex min-w-0 items-center gap-1 overflow-x-auto px-1 py-0.5"
    >
      {workspaces.map((w, i) => {
        const isActive = w.id === activeId;
        const n = counts.get(w.id) ?? 0;
        // Where a dragged workspace would land: after this one when it comes
        // from the left, before it from the right. The bar is drawn on that side.
        const dragFrom = dragWs ? workspaces.findIndex((x) => x.id === dragWs) : -1;
        const dropBar =
          dragOverWs === w.id && dragWs !== w.id
            ? dragFrom < i
              ? "right"
              : "left"
            : null;
        return (
          <ContextMenu key={w.id}>
            <ContextMenuTrigger asChild>
              <div
                ref={(el) => {
                  if (el) chipRefs.current.set(w.id, el);
                  else chipRefs.current.delete(w.id);
                }}
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                // Off while renaming: a draggable ancestor swallows text
                // selection in the input, the same as on a tab.
                draggable={renaming !== w.id}
                onClick={() => onSwitch(w.id)}
                onDoubleClick={() => startRename(w)}
                onKeyDown={(e) => {
                  if (e.key === "F2") startRename(w);
                }}
                onDragStart={(e) => {
                  setDragWs(w.id);
                  e.dataTransfer.effectAllowed = "move";
                  // Some webviews reject a drag that carries no data.
                  e.dataTransfer.setData("text/plain", w.name);
                }}
                onDragEnd={endWsDrag}
                onDragOver={(e) => {
                  if (draggingTabId) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropOver !== w.id) setDropOver(w.id);
                  } else if (dragWs) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverWs !== w.id) setDragOverWs(w.id);
                  }
                }}
                onDragLeave={() => setDropOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropOver(null);
                  if (draggingTabId) onDropTab(draggingTabId, w.id);
                  else if (dragWs) onReorder(dragWs, w.id);
                  endWsDrag();
                }}
                className={cn(
                  "group relative flex h-7 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs",
                  isActive
                    ? "border-primary/60 bg-accent text-foreground"
                    : "border-border/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  dropOver === w.id && "ring-2 ring-primary",
                  dragWs === w.id && "opacity-40",
                )}
                {...hint(
                  isActive
                    ? `${w.name}: the workspace on screen. Double-click to rename, right-click for its colour and Close, drag to move it along the row`
                    : `Show ${w.name}. Its terminals keep running while hidden. Drop a tab here to move it, or drag this along the row to reorder`,
                )}
              >
                {dropBar && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-y-0.5 w-0.5 rounded-full bg-primary",
                      dropBar === "left" ? "-left-[3px]" : "-right-[3px]",
                    )}
                  />
                )}
                <span
                  aria-hidden="true"
                  className={cn(
                    "block h-2.5 w-2.5 shrink-0 rounded-full border border-border",
                    !w.color && "border-dashed",
                  )}
                  style={w.color ? { backgroundColor: w.color } : undefined}
                />
                {renaming === w.id ? (
                  <input
                    ref={renameRef}
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    aria-label="Workspace name"
                    className="w-32 rounded-sm bg-background px-1 text-xs outline-none ring-1 ring-ring"
                  />
                ) : (
                  <span className="truncate">{w.name}</span>
                )}
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {n}
                </span>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              onCloseAutoFocus={(e) => {
                if (!renameFromMenu.current) return;
                renameFromMenu.current = false;
                e.preventDefault();
                renameRef.current?.focus();
                renameRef.current?.select();
              }}
            >
              <ContextMenuLabel className="max-w-56 truncate">
                {w.name}
              </ContextMenuLabel>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => {
                  renameFromMenu.current = true;
                  startRename(w);
                }}
              >
                <PencilIcon />
                Rename
              </ContextMenuItem>
              <div className="grid grid-cols-6 gap-1 px-2 py-1.5">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => onRecolor(w.id, c)}
                    aria-label={`Colour ${c}`}
                    className={cn(
                      "h-5 w-5 rounded-sm border-2",
                      w.color.toLowerCase() === c.toLowerCase()
                        ? "border-foreground"
                        : "border-transparent",
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <ContextMenuItem onSelect={() => onRecolor(w.id, "")}>
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 rounded-sm border border-dashed border-border"
                />
                No colour
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => onClose(w.id)}
                className="text-destructive focus:text-destructive"
              >
                <XIcon />
                {n === 0
                  ? "Close workspace"
                  : `Close workspace and its ${n} ${n === 1 ? "tab" : "tabs"}`}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
      <button
        type="button"
        onClick={onNew}
        aria-label="New workspace"
        className="flex h-7 shrink-0 items-center rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        {...hint("Start an empty workspace and show it")}
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
