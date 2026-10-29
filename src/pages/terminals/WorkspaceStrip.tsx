import { useState } from "react";
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
};

/**
 * The row of workspaces above the tab strip. Only drawn with two or more: with
 * one there is nothing to switch between, and the Terminals tab looks exactly
 * as it did before workspaces existed.
 *
 * Click to show a workspace, double-click to rename it, right-click for its
 * colour and Close. A tab dragged from the strip below can be dropped on one
 * to move it there.
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
}: Props) {
  const hint = useHint();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dropOver, setDropOver] = useState<string | null>(null);

  const startRename = (w: Workspace) => {
    setDraft(w.name);
    setRenaming(w.id);
  };
  const commitRename = () => {
    if (renaming) onRename(renaming, draft);
    setRenaming(null);
  };

  return (
    <div
      role="tablist"
      aria-label="Workspaces"
      className="flex min-w-0 items-center gap-1 overflow-x-auto px-2 pt-2"
    >
      {workspaces.map((w) => {
        const isActive = w.id === activeId;
        const n = counts.get(w.id) ?? 0;
        return (
          <ContextMenu key={w.id}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onSwitch(w.id)}
                onDoubleClick={() => startRename(w)}
                onKeyDown={(e) => {
                  if (e.key === "F2") startRename(w);
                }}
                onDragOver={(e) => {
                  if (!draggingTabId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dropOver !== w.id) setDropOver(w.id);
                }}
                onDragLeave={() => setDropOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropOver(null);
                  if (draggingTabId) onDropTab(draggingTabId, w.id);
                }}
                className={cn(
                  "group flex h-7 max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs",
                  isActive
                    ? "border-primary/60 bg-accent text-foreground"
                    : "border-border/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  dropOver === w.id && "ring-2 ring-primary",
                )}
                {...hint(
                  isActive
                    ? `${w.name}: the workspace on screen. Double-click to rename, right-click for its colour and Close`
                    : `Show ${w.name}. Its terminals keep running while hidden. Drop a tab here to move it`,
                )}
              >
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
            <ContextMenuContent>
              <ContextMenuLabel className="max-w-56 truncate">
                {w.name}
              </ContextMenuLabel>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => startRename(w)}>
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
