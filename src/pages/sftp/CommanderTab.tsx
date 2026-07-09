import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  FolderSymlinkIcon,
  HardDriveIcon,
  Loader2Icon,
  MonitorIcon,
  PlugIcon,
  PlugZapIcon,
  RefreshCwIcon,
  ServerIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TofuKeyDialog } from "@/components/TofuKeyDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import { errorMessage } from "@/lib/tauri/hosts";
import { localScanDir } from "@/lib/tauri/localfs";
import { type TransferMode, sftpScanDir } from "@/lib/tauri/sftp";
import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";
import {
  clashText,
  formatMtime,
  formatSize,
  isLargeTransfer,
  winJoin,
} from "@/pages/sftp/model";
import { useLocalBrowser } from "@/pages/sftp/useLocalBrowser";
import {
  type ActiveTransfer,
  useSftpBrowser,
} from "@/pages/sftp/useSftpBrowser";

type PaneSide = "local" | "remote";

/** The row shape both panes share (LocalEntry and SftpEntry both satisfy it). */
type PaneEntry = {
  name: string;
  path: string;
  kind: string;
  size: number | null;
  mtime: number | null;
};

/** One file/folder being dragged. */
type DragItem = { path: string; name: string; kind: string };
/** A drag carries every selected item from the originating pane (Windows-style
 *  Ctrl/Shift multi-select), so one drag can transfer many files at once. */
type DragPayload = { side: PaneSide; items: DragItem[] };

const DND_MIME = "application/x-broadside-file";
const SPLIT_KEY = "sftp-split-pct";

/**
 * SFTP Commander: a dual-pane file manager. Local filesystem on the left, the
 * connected remote host on the right. Navigate each side by clicking folders;
 * transfer a file by **dragging it to the other pane** (local→remote = put,
 * remote→local = get) or by **double-clicking** it. Both panes support New
 * folder and (double-click) Delete — local deletes go to the Recycle Bin, remote
 * deletes are permanent. Files only for transfers this pass.
 */
export function CommanderTab({
  visible,
  mode,
}: {
  visible: boolean;
  mode: TransferMode;
}) {
  const local = useLocalBrowser(visible);
  const remote = useSftpBrowser(visible);

  const [pickedHostId, setPickedHostId] = useState<string>("");
  const [newFolderSide, setNewFolderSide] = useState<PaneSide | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [deleting, setDeleting] = useState<{
    side: PaneSide;
    entry: PaneEntry;
  } | null>(null);
  // A large folder pending confirmation before it transfers.
  const [pendingDir, setPendingDir] = useState<{
    direction: "put" | "get";
    path: string;
    name: string;
    files: number;
    bytes: number;
  } | null>(null);
  // Which pane Backspace acts on — set to whichever pane was last clicked.
  const [activePane, setActivePane] = useState<PaneSide>("local");

  // Resizable split (percent width of the left pane), persisted.
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(() => {
    const saved = Number(localStorage.getItem(SPLIT_KEY));
    return saved >= 20 && saved <= 80 ? saved : 50;
  });
  useEffect(() => {
    localStorage.setItem(SPLIT_KEY, String(Math.round(leftPct)));
  }, [leftPct]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(80, Math.max(20, pct)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, []);

  // Backspace goes up a directory in the active pane (the one last clicked),
  // unless the user is typing in a field or a dialog is open.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (el as HTMLElement | null)?.isContentEditable
      ) {
        return;
      }
      // Don't hijack Backspace while any dialog is open.
      if (document.querySelector("[role='dialog'],[role='alertdialog']")) return;
      e.preventDefault();
      if (activePane === "local") local.goUp();
      else remote.goUp();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, activePane, local, remote]);

  const onConnect = () => {
    const host = remote.hosts.find((h) => h.id === Number(pickedHostId));
    if (host) remote.connect(host);
  };

  // --- Transfers ---
  const putToRemote = useCallback(
    async (localPath: string) => {
      if (!remote.session) {
        toast.error("Connect to a host first");
        return;
      }
      await remote.upload(localPath); // uploads into the remote cwd + refreshes it
    },
    [remote],
  );

  const getToLocal = useCallback(
    async (entry: { path: string; name: string }) => {
      if (!remote.session) return;
      if (local.cwd === null) {
        toast.error("Open a local folder first (you're at the drive list)");
        return;
      }
      await remote.download(entry, winJoin(local.cwd, entry.name));
      local.refresh();
    },
    [remote, local],
  );

  // Actually runs a folder transfer (after any confirmation). `totals` seed the
  // progress bar (from the pre-flight scan).
  const runDirTransfer = useCallback(
    async (
      direction: "put" | "get",
      path: string,
      name: string,
      totals: { files: number; bytes: number },
    ) => {
      if (direction === "put") {
        await remote.uploadDir(path, mode, totals);
      } else {
        if (local.cwd === null) return;
        await remote.downloadDir(
          { path, name },
          winJoin(local.cwd, name),
          mode,
          totals,
        );
        local.refresh();
      }
    },
    [remote, local, mode],
  );

  // Folder transfer: scan first, then gate on a confirmation when it's large.
  const handleDirDrop = useCallback(
    async (direction: "put" | "get", path: string, name: string) => {
      const session = remote.session;
      if (!session) {
        toast.error("Connect to a host first");
        return;
      }
      if (direction === "get" && local.cwd === null) {
        toast.error("Open a local folder first (you're at the drive list)");
        return;
      }
      const t = toast.loading(`Scanning ${name}…`);
      let files: number;
      let bytes: number;
      try {
        const stats =
          direction === "put"
            ? await localScanDir(path)
            : await sftpScanDir(session.sessionId, path);
        files = stats.files;
        bytes = stats.bytes;
      } catch (e) {
        toast.dismiss(t);
        toast.error(errorMessage(e));
        return;
      }
      toast.dismiss(t);
      if (isLargeTransfer(files, bytes)) {
        setPendingDir({ direction, path, name, files, bytes });
      } else {
        void runDirTransfer(direction, path, name, { files, bytes });
      }
    },
    [remote, local, runDirTransfer],
  );

  // A file/folder dropped onto a pane came from the *other* side, so it's a
  // transfer into this pane's directory.
  const onDropInto = useCallback(
    async (side: PaneSide, payload: DragPayload) => {
      if (payload.side === side) return;
      const direction = side === "remote" ? "put" : "get";
      // Transfer the dropped items one at a time — a single SFTP session can't
      // safely run several uploads/downloads concurrently.
      for (const item of payload.items) {
        if (item.kind === "dir") {
          await handleDirDrop(direction, item.path, item.name);
        } else if (side === "remote") {
          await putToRemote(item.path);
        } else {
          await getToLocal({ path: item.path, name: item.name });
        }
      }
    },
    [handleDirDrop, putToRemote, getToLocal],
  );

  const submitNewFolder = () => {
    if (newFolderSide === "local") local.mkdir(newFolderName);
    else if (newFolderSide === "remote") remote.mkdir(newFolderName);
    setNewFolderName("");
    setNewFolderSide(null);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    if (deleting.side === "local") local.remove(deleting.entry);
    else remote.remove(deleting.entry);
    setDeleting(null);
  };

  const newFolderCwd =
    newFolderSide === "local" ? local.cwd : remote.session?.cwd ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={containerRef} className="flex min-h-0 flex-1 items-stretch p-2">
        {/* LEFT: local filesystem */}
        <div className="min-w-0 shrink-0" style={{ width: `${leftPct}%` }}>
          <FilePane
            side="local"
            title={
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <MonitorIcon className="h-4 w-4 text-muted-foreground" />
                This PC
              </span>
            }
            pathLabel={local.cwd ?? "Drives"}
            entries={local.entries}
            loading={local.loading}
            busy={local.busy}
            canUp={local.cwd !== null}
            onUp={local.goUp}
            onRefresh={local.refresh}
            onNavigate={local.navigate}
            onDropInto={(p) => onDropInto("local", p)}
            onActivate={() => setActivePane("local")}
            // No mkdir/delete at the drive list (cwd === null).
            onNewFolder={
              local.cwd !== null ? () => setNewFolderSide("local") : undefined
            }
            onDeleteEntry={
              local.cwd !== null
                ? (entry) => setDeleting({ side: "local", entry })
                : undefined
            }
            emptyText="Empty folder."
          />
        </div>

        {/* Draggable splitter */}
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startResize}
          className="group mx-1 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
          title="Drag to resize"
        >
          <div className="h-10 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary/60" />
        </div>

        {/* RIGHT: remote host. Plain block (not flex) so the FilePane fills the
            full width like the left pane — a flex wrapper would size the pane to
            its content and leave a gap on the right. */}
        <div className="min-w-0 flex-1">
          {remote.session ? (
            <FilePane
              side="remote"
              title={
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: remote.session.host.color }}
                  />
                  {remote.session.host.label}
                </span>
              }
              pathLabel={remote.session.cwd}
              entries={remote.entries}
              loading={remote.listing}
              busy={remote.busy}
              canUp={remote.session.cwd !== "/"}
              onUp={remote.goUp}
              onRefresh={remote.refresh}
              onNavigate={remote.navigate}
              onDropInto={(p) => onDropInto("remote", p)}
              onActivate={() => setActivePane("remote")}
              onNewFolder={() => setNewFolderSide("remote")}
              onDeleteEntry={(entry) => setDeleting({ side: "remote", entry })}
              emptyText="Empty directory."
              headerRight={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={remote.disconnect}
                >
                  <PlugZapIcon />
                  Disconnect
                </Button>
              }
            />
          ) : (
            <RemoteConnectPane
              hosts={remote.hosts}
              pickedHostId={pickedHostId}
              setPickedHostId={setPickedHostId}
              connecting={remote.connecting}
              onConnect={onConnect}
            />
          )}
        </div>
      </div>

      {/* Live progress for a recursive folder transfer */}
      {remote.transfer && (
        <TransferBar transfer={remote.transfer} onCancel={remote.cancelTransfer} />
      )}

      {/* New-folder dialog (both sides) */}
      <Dialog
        open={newFolderSide !== null}
        onOpenChange={(o) => !o && setNewFolderSide(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-folder-name" className="text-xs font-normal">
              Folder name (created in{" "}
              <span className="font-mono">{newFolderCwd}</span>)
            </Label>
            <Input
              id="new-folder-name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newFolderName.trim()) submitNewFolder();
              }}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderSide(null)}>
              Cancel
            </Button>
            <Button onClick={submitNewFolder} disabled={!newFolderName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation (both sides) */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.entry.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.side === "local" ? (
                <>
                  This moves{" "}
                  <span className="font-mono text-foreground">
                    {deleting?.entry.path}
                  </span>{" "}
                  to the <span className="font-medium">Recycle Bin</span>.
                </>
              ) : (
                <>
                  This permanently removes{" "}
                  <span className="font-mono text-foreground">
                    {deleting?.entry.path}
                  </span>{" "}
                  from {remote.session?.host.label}.
                  {deleting?.entry.kind === "dir" &&
                    " The folder must be empty, or the server will refuse."}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Large-folder confirmation (recursive transfer gate) */}
      <AlertDialog
        open={pendingDir !== null}
        onOpenChange={(o) => !o && setPendingDir(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <TriangleAlertIcon className="h-5 w-5" />
              Large transfer
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-foreground">{pendingDir?.name}</span>{" "}
              contains{" "}
              <span className="font-semibold text-foreground">
                {pendingDir?.files} files
              </span>{" "}
              ({formatSize(pendingDir?.bytes ?? 0)}). This will{" "}
              {pendingDir?.direction === "put" ? (
                <>
                  <span className="font-medium">upload</span> the folder to{" "}
                  <span className="font-mono text-foreground">
                    {remote.session?.cwd}
                  </span>{" "}
                  on {remote.session?.host.label}
                </>
              ) : (
                <>
                  <span className="font-medium">download</span> the folder to{" "}
                  <span className="font-mono text-foreground">{local.cwd}</span> on
                  this PC
                </>
              )}
              . {clashText(mode)} Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDir)
                  void runDirTransfer(
                    pendingDir.direction,
                    pendingDir.path,
                    pendingDir.name,
                    { files: pendingDir.files, bytes: pendingDir.bytes },
                  );
                setPendingDir(null);
              }}
            >
              {pendingDir?.direction === "put" ? "Upload" : "Download"}{" "}
              {pendingDir?.files} files
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Host-key trust dialogs (reused from the Hosts Test flow). */}
      <TofuKeyDialog
        open={remote.tofu !== null}
        onOpenChange={(o) => !o && remote.setTofu(null)}
        host={remote.tofu?.host ?? null}
        presentedKey={remote.tofu?.key ?? null}
        onTrusted={remote.connect}
      />
      <KeyMismatchDialog
        open={remote.mismatch !== null}
        onOpenChange={(o) => !o && remote.setMismatch(null)}
        host={remote.mismatch?.host ?? null}
        storedFingerprint={remote.mismatch?.stored ?? null}
        presented={remote.mismatch?.presented ?? null}
        onTrusted={remote.connect}
      />
    </div>
  );
}

/** One pane: header + path bar + a drag/drop-aware listing. Rounded + subtly
 *  shaded so each side reads as its own panel against the tab background. */
function FilePane({
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
  useEffect(() => {
    setSelected(new Set());
    anchorRef.current = -1;
  }, [pathLabel]);

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
    if (e.shiftKey && anchorRef.current >= 0) {
      const lo = Math.min(anchorRef.current, index);
      const hi = Math.max(anchorRef.current, index);
      const range = entries
        .slice(lo, hi + 1)
        .filter((en) => !(side === "local" && /^[A-Za-z]:\\?$/.test(en.path)))
        .map((en) => en.path);
      setSelected(new Set(range));
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
      {/* Listing — the whole body is the drop target for the other pane. */}
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
                      .map((en) => ({ path: en.path, name: en.name, kind: en.kind }));
                  } else {
                    setSelected(new Set([entry.path]));
                    items = [{ path: entry.path, name: entry.name, kind: entry.kind }];
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
                      ? `${entry.name} — open it, or drag to the other pane to transfer the folder`
                      : `${entry.name} — click to select, Ctrl/Shift-click for many, drag to transfer`
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

/** Bottom bar showing live progress of a recursive folder transfer + Cancel. */
function TransferBar({
  transfer,
  onCancel,
}: {
  transfer: ActiveTransfer;
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const pct =
    transfer.bytesTotal > 0
      ? Math.min(100, (transfer.bytesDone / transfer.bytesTotal) * 100)
      : transfer.filesTotal > 0
        ? Math.min(100, (transfer.filesDone / transfer.filesTotal) * 100)
        : null;
  return (
    <div className="shrink-0 border-t border-border/50 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <Loader2Icon className="h-3.5 w-3.5 animate-spin text-primary" />
        <span className="font-medium">
          {transfer.direction === "put" ? "Uploading" : "Downloading"}{" "}
          <span className="font-mono">{transfer.name}</span>
        </span>
        <span className="tabular-nums text-muted-foreground">
          {transfer.filesDone}
          {transfer.filesTotal ? `/${transfer.filesTotal}` : ""} files ·{" "}
          {formatSize(transfer.bytesDone)}
          {transfer.bytesTotal ? ` / ${formatSize(transfer.bytesTotal)}` : ""}
          {pct !== null ? ` · ${Math.round(pct)}%` : ""}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-destructive"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            onCancel();
          }}
        >
          <XIcon />
          {cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-primary",
            pct === null
              ? "w-1/3 animate-pulse"
              : "transition-[width] duration-150",
          )}
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}

/** Right pane before a host is connected: host picker + Connect. */
function RemoteConnectPane({
  hosts,
  pickedHostId,
  setPickedHostId,
  connecting,
  onConnect,
}: {
  hosts: ReturnType<typeof useSftpBrowser>["hosts"];
  pickedHostId: string;
  setPickedHostId: (v: string) => void;
  connecting: boolean;
  onConnect: () => void;
}) {
  const hint = useHint();
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-2 text-sm font-medium">
        <ServerIcon className="h-4 w-4 text-muted-foreground" />
        Remote host
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
        <p className="text-sm text-muted-foreground">
          Connect to a host to browse and transfer files.
        </p>
        <div className="flex items-center gap-2">
          <Select value={pickedHostId} onValueChange={setPickedHostId}>
            <SelectTrigger className="h-9 min-w-52" aria-label="Host">
              <SelectValue placeholder="Select a host…" />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={h.id} value={String(h.id)}>
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: h.color }}
                  />
                  {h.label} ({h.username}@{h.hostname}:{h.port})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={onConnect}
            disabled={!pickedHostId || connecting}
            {...hint("Open an SFTP session to the selected host")}
          >
            {connecting ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
            Connect
          </Button>
        </div>
        {hosts.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No hosts configured. Add hosts on the Hosts page first.
          </span>
        )}
      </div>
    </div>
  );
}
