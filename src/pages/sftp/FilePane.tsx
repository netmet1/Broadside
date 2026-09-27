import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderSymlinkIcon,
  HardDriveIcon,
  Loader2Icon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";
import { formatMtime, formatSize } from "@/pages/sftp/model";

export type PaneSide = "local" | "remote";

/** The row shape both panes share (LocalEntry and SftpEntry both satisfy it). */
export type PaneEntry = {
  name: string;
  path: string;
  kind: string;
  size: number | null;
  mtime: number | null;
};

/** One file/folder being dragged. `size` comes along so a single-file transfer
 *  can show a percentage: both panes already know it from their listing, and
 *  asking the far end again for a number we are holding would be a round trip
 *  for nothing. Null for a folder, whose real size needs the pre-flight scan. */
export type DragItem = {
  path: string;
  name: string;
  kind: string;
  size?: number | null;
};
/** A drag carries every selected item from the originating pane (Windows-style
 *  Ctrl/Shift multi-select), so one drag can transfer many files at once. */
export type DragPayload = { side: PaneSide; items: DragItem[] };

const DND_MIME = "application/x-broadside-file";

/** One pane: header + path bar + a drag/drop-aware listing. Rounded + subtly
 *  shaded so each side reads as its own panel against the tab background. */
export function FilePane({
  side,
  title,
  pathLabel,
  entries,
  loading,
  busy,
  canUp,
  onUp,
  onRefresh,
  onNavigate,
  onDropInto,
  onActivate,
  onNewFolder,
  onDeleteEntry,
  emptyText,
  headerRight,
}: {
  side: PaneSide;
  title: ReactNode;
  pathLabel: string;
  entries: PaneEntry[];
  loading: boolean;
  busy?: boolean;
  canUp: boolean;
  onUp: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onDropInto: (payload: DragPayload) => void;
  onActivate: () => void;
  onNewFolder?: () => void;
  onDeleteEntry?: (entry: PaneEntry) => void;
  emptyText: string;
  headerRight?: ReactNode;
}) {
  const hint = useHint();
  const [dropActive, setDropActive] = useState(false);

  // Windows Explorer–style selection: a set of selected paths plus the anchor
  // row index for Shift-range selection. Cleared whenever the directory changes.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorRef = useRef(-1);
  // Clear the selection whenever the listing reloads: a new reference lands on
  // navigation *and* on an explicit Refresh (same folder, fresh entries), so a
  // stale selection never survives either.
  // The set is state and resets during render; the anchor is a ref, which a
  // render must not touch, so it is cleared in a layout effect. Both land
  // before anything can act on them: a layout effect runs ahead of every
  // passive effect, and the click handler that reads the anchor cannot fire
  // until the browser paints.
  const [prevEntries, setPrevEntries] = useState(entries);
  if (prevEntries !== entries) {
    setPrevEntries(entries);
    setSelected(new Set());
  }
  useLayoutEffect(() => {
    anchorRef.current = -1;
  }, [entries]);

  // Click on a row, honoring Ctrl (toggle), Shift (range), or plain (single).
  // Folders still open on a plain click; drives always just open.
  const onRowClick = (
    e: React.MouseEvent,
    index: number,
    entry: PaneEntry,
    isDrive: boolean,
  ) => {
    if (isDrive) {
      onNavigate(entry.path);
      return;
    }
    // Shift-click never opens a folder: it extends a range from the anchor, or
    // (with no anchor yet) begins the selection right here so a folder can be
    // the start of a range instead of being navigated into.
    if (e.shiftKey) {
      if (anchorRef.current >= 0) {
        const lo = Math.min(anchorRef.current, index);
        const hi = Math.max(anchorRef.current, index);
        const range = entries
          .slice(lo, hi + 1)
          .filter((en) => !(side === "local" && /^[A-Za-z]:\\?$/.test(en.path)))
          .map((en) => en.path);
        setSelected(new Set(range));
      } else {
        anchorRef.current = index;
        setSelected(new Set([entry.path]));
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      anchorRef.current = index;
      return;
    }
    anchorRef.current = index;
    if (entry.kind === "dir") {
      setSelected(new Set());
      onNavigate(entry.path);
    } else {
      setSelected(new Set([entry.path]));
    }
  };

  const readPayload = (e: React.DragEvent): DragPayload | null => {
    const raw = e.dataTransfer.getData(DND_MIME);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DragPayload;
    } catch {
      return null;
    }
  };

  return (
    <div
      onMouseDown={onActivate}
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/20"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        {title}
        <div className="ml-auto flex items-center gap-1">
          {onNewFolder && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onNewFolder}
              disabled={busy}
              {...hint("Create a new folder in this directory")}
            >
              <FolderPlusIcon />
              New folder
            </Button>
          )}
          {headerRight}
        </div>
      </div>
      {/* Path bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/30 px-3 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onUp}
          disabled={!canUp || loading}
          aria-label="Up one directory"
          {...hint("Go to the parent directory")}
        >
          <ArrowUpIcon />
        </Button>
        <code className="min-w-0 flex-1 truncate rounded bg-muted/40 px-2 py-1 font-mono text-xs text-foreground/80">
          {pathLabel}
        </code>
        {loading && (
          <Loader2Icon className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh"
          {...hint("Reload this directory")}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {/* Listing, the whole body is the drop target for the other pane. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto transition-colors",
          dropActive && "bg-primary/10 ring-2 ring-inset ring-primary/40",
        )}
        onDragOver={(e) => {
          // Only accept drops that originated in the other pane.
          if (!e.dataTransfer.types.includes(DND_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!dropActive) setDropActive(true);
        }}
        onDragLeave={(e) => {
          // Ignore leave events bubbling from children still inside the pane.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDropActive(false);
        }}
        onDrop={(e) => {
          setDropActive(false);
          const payload = readPayload(e);
          if (!payload) return;
          e.preventDefault();
          onDropInto(payload);
        }}
      >
        {entries.length === 0 && !loading && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        )}
        {/* select-none so Shift-click selects rows, not native text. */}
        <ul className="divide-y divide-border/30 select-none">
          {entries.map((entry, index) => {
            const isDir = entry.kind === "dir";
            const isLink = entry.kind === "symlink";
            const isDrive = side === "local" && /^[A-Za-z]:\\?$/.test(entry.path);
            const isSelected = selected.has(entry.path);
            return (
              <li
                key={entry.path}
                // Files and folders both drag to the other pane; drives don't.
                draggable={!isDrive}
                onClick={(e) => onRowClick(e, index, entry, isDrive)}
                onDragStart={(e) => {
                  if (isDrive) {
                    e.preventDefault();
                    return;
                  }
                  // Drag every selected row when this row is part of a multi-
                  // selection; otherwise this row alone (and make it the
                  // selection, so the highlight matches what's being dragged).
                  let items: DragItem[];
                  if (isSelected && selected.size > 1) {
                    items = entries
                      .filter((en) => selected.has(en.path))
                      .map((en) => ({
                        path: en.path,
                        name: en.name,
                        kind: en.kind,
                        size: en.size,
                      }));
                  } else {
                    setSelected(new Set([entry.path]));
                    items = [
                      {
                        path: entry.path,
                        name: entry.name,
                        kind: entry.kind,
                        size: entry.size,
                      },
                    ];
                  }
                  const payload: DragPayload = { side, items };
                  e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                aria-selected={isSelected}
                className={cn(
                  "flex items-center gap-3 px-3 py-1.5 text-sm",
                  isSelected ? "bg-primary/15" : "hover:bg-accent/40",
                  !isDrive && "cursor-grab active:cursor-grabbing",
                )}
                title={
                  isDrive
                    ? entry.name
                    : isDir
                      ? `${entry.name}: open it, or drag to the other pane to transfer the folder`
                      : `${entry.name}: click to select, Ctrl/Shift-click for many, drag to transfer`
                }
              >
                <div
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 text-left",
                    isDir ? "cursor-pointer" : "cursor-grab",
                  )}
                >
                  {isDrive ? (
                    <HardDriveIcon className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : isDir ? (
                    <FolderIcon className="h-4 w-4 shrink-0 text-sky-500" />
                  ) : isLink ? (
                    <FolderSymlinkIcon className="h-4 w-4 shrink-0 text-teal-500" />
                  ) : (
                    <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </div>
                <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {isDir ? "" : formatSize(entry.size)}
                </span>
                <span className="hidden w-32 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground lg:inline">
                  {formatMtime(entry.mtime)}
                </span>
                <span className="flex w-8 shrink-0 items-center justify-end">
                  {onDeleteEntry && !isDrive && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      // Double-click (not single) to delete, per design; stop the
                      // events reaching the row so they don't also transfer/navigate.
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onDeleteEntry(entry);
                      }}
                      disabled={busy}
                      aria-label={`Delete ${entry.name}`}
                      title="Double-click to delete"
                    >
                      <Trash2Icon className="text-destructive" />
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
