import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MonitorIcon, PlugZapIcon, TriangleAlertIcon } from "lucide-react";
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
import { TofuKeyDialog } from "@/components/TofuKeyDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import { useActivity } from "@/lib/activity";
import { type TransferMode } from "@/lib/tauri/sftp";
import { setToastLift } from "@/lib/toastLift";
import {
  clashText,
  formatSize,
  isLargeTransfer,
  winDirname,
  winJoin,
} from "@/pages/sftp/model";
import {
  type DragPayload,
  type PaneEntry,
  type PaneSide,
  FilePane,
} from "@/pages/sftp/FilePane";
import { RemoteConnectPane } from "@/pages/sftp/RemoteConnectPane";
import { type RenameTarget, RenameDialog } from "@/pages/sftp/RenameDialog";
import { TransferStack } from "@/pages/sftp/TransferRail";
import { useLocalBrowser } from "@/pages/sftp/useLocalBrowser";
import { type TransferBatch, useSftpBrowser } from "@/pages/sftp/useSftpBrowser";

/** A folder transfer as it was asked for: which way, what, and (for a
 *  download) where it lands. The destination is fixed at the drop, because
 *  that is where the user meant it to go even if they navigate while it is
 *  scanned or asked about. */
type DirRequest = {
  direction: "put" | "get";
  path: string;
  name: string;
  /** The local folder a download creates (the drop folder joined with
   *  `name`); unused for an upload, which goes to the remote cwd. */
  localDest: string;
  batch: TransferBatch;
};

/** A folder that came back from the pre-flight scan big enough to ask about. */
type PendingDir = DirRequest & {
  id: string;
  files: number;
  bytes: number;
};

const SPLIT_KEY = "sftp-split-pct";

/**
 * SFTP Commander: a dual-pane file manager. Local filesystem on the left, the
 * connected remote host on the right. A click selects; a double-click or Enter
 * opens a folder. Transfer by **dragging to the other pane** (local→remote =
 * put, remote→local = get). Both panes support New folder, Rename (F2 or the
 * pencil) and (double-click) Delete: local deletes go to the Recycle Bin,
 * remote deletes are permanent.
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
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  // The row each pane should select once its re-list lands: the one just
  // renamed, which has a new path and so would otherwise lose its highlight.
  const [reselect, setReselect] = useState<{
    local: { path: string } | null;
    remote: { path: string } | null;
  }>({ local: null, remote: null });
  // Large folders awaiting confirmation, asked about one at a time. A queue
  // rather than a single slot because one drag can carry several of them, and a
  // single slot means the second folder's dialog replaces the first's and the
  // first is silently forgotten.
  const [pendingDirs, setPendingDirs] = useState<PendingDir[]>([]);
  const pendingDir = pendingDirs[0] ?? null;
  // A question belongs to the session it was asked for. Once that session goes
  // (disconnect, or the host dropping it), what was waiting to be asked about
  // goes too: confirming a transfer to a host that is no longer there means
  // nothing, and the disconnect has already said what each drop managed.
  const liveSessionId = remote.session?.sessionId ?? null;
  const [pendingFor, setPendingFor] = useState(liveSessionId);
  if (pendingFor !== liveSessionId) {
    setPendingFor(liveSessionId);
    setPendingDirs([]);
  }
  // Which pane the keys (Backspace, Enter, arrows) act on: the one last clicked.
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

  const onConnect = () => {
    const host = remote.hosts.find((h) => h.id === Number(pickedHostId));
    if (host) remote.connect(host);
  };

  // --- Transfers ---

  // Puts a folder in the queue (after any confirmation). `totals` seed the
  // progress bar (from the pre-flight scan).
  const queueDirTransfer = useCallback(
    (req: DirRequest, totals: { files: number; bytes: number }) => {
      if (req.direction === "put") {
        remote.uploadDir(req.path, req.batch.mode, totals, req.batch);
      } else {
        remote.downloadDir(
          { path: req.path, name: req.name },
          req.localDest,
          req.batch.mode,
          totals,
          req.batch,
        );
      }
    },
    [remote],
  );

  // Folder transfer: scan first (a row in the rail, with its own Cancel), then
  // gate on a confirmation when it's large.
  const handleDirDrop = useCallback(
    async (req: DirRequest) => {
      const totals = await remote.scanDir(req.direction, req.path, req.name);
      if (!totals) {
        remote.settle(req.batch);
        return;
      }
      if (isLargeTransfer(totals.files, totals.bytes)) {
        setPendingDirs((prev) => [
          ...prev,
          { ...req, ...totals, id: crypto.randomUUID() },
        ]);
      } else {
        queueDirTransfer(req, totals);
      }
    },
    [remote, queueDirTransfer],
  );

  // Answers the Large-transfer question for one folder, once. Both buttons
  // close the dialog, and closing it reports "not confirmed" as well, so the
  // confirm button's answer arrives first and the close that follows it must
  // be a no-op rather than a second answer (that second answer used to throw
  // away the next folder in line without asking about it).
  const answered = useRef(new Set<string>());
  const answerPendingDir = useCallback(
    (p: PendingDir, confirmed: boolean) => {
      if (answered.current.has(p.id)) return;
      answered.current.add(p.id);
      if (confirmed) queueDirTransfer(p, { files: p.files, bytes: p.bytes });
      else remote.settle(p.batch);
      setPendingDirs((prev) => prev.filter((q) => q.id !== p.id));
    },
    [queueDirTransfer, remote],
  );

  // A file/folder dropped onto a pane came from the *other* side, so it's a
  // transfer into this pane's directory.
  //
  // Files go straight into the transfer queue, which runs a few at a time and
  // holds the rest. Folders follow, one scan after another, because a scan is a
  // question the far end has to answer and a big one may need confirming before
  // it can join the queue at all.
  const onDropInto = useCallback(
    async (side: PaneSide, payload: DragPayload) => {
      if (payload.side === side) return;
      const direction = side === "remote" ? "put" : "get";
      // Checked once for the whole drop, not once per item: twenty files with
      // nowhere to go should say so once.
      if (!remote.session) {
        toast.error("Connect to a host first");
        return;
      }
      const localCwd = local.cwd;
      if (direction === "get" && localCwd === null) {
        toast.error("Open a local folder first (you're at the drive list)");
        return;
      }
      // One drop, one success toast once everything in it has settled.
      const batch = remote.beginBatch(direction, payload.items.length, mode);
      for (const item of payload.items) {
        if (item.kind === "dir") continue;
        if (direction === "put") {
          // The size only feeds the progress bar, so a null one costs a
          // percentage and nothing else.
          remote.upload(item.path, item.size ?? undefined, batch);
        } else {
          remote.download(
            { path: item.path, name: item.name, size: item.size ?? undefined },
            winJoin(localCwd ?? "", item.name),
            batch,
          );
        }
      }
      for (const item of payload.items) {
        if (item.kind !== "dir") continue;
        await handleDirDrop({
          direction,
          path: item.path,
          name: item.name,
          localDest: winJoin(localCwd ?? "", item.name),
          batch,
        });
      }
    },
    [handleDirDrop, remote, local, mode],
  );

  // The local listing is re-read a moment after a download lands in it (the
  // remote half is the hook's own job). Latched on the sequence number so
  // navigating during a transfer, which gives `refresh` a new identity, is not
  // mistaken for something having arrived.
  const localRefresh = local.refresh;
  const localRelist = remote.relistSeq.local;
  const handledRelist = useRef(0);
  useEffect(() => {
    if (localRelist === handledRelist.current) return;
    handledRelist.current = localRelist;
    localRefresh();
  }, [localRelist, localRefresh]);

  // Toasts share the bottom-right corner with the rail's Cancel buttons, so
  // while the rail is up on this tab they are raised to sit just above it.
  const railRef = useRef<HTMLDivElement>(null);
  const railShown = visible && remote.transfers.length > 0;
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!railShown || !el) return;
    const measure = () =>
      setToastLift(window.innerHeight - el.getBoundingClientRect().top + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      setToastLift(0);
    };
  }, [railShown]);

  // Say so on the status bar while transfers are running, so leaving the tab
  // does not leave the operator wondering whether anything is still happening.
  const inFlight = remote.transfers.length;
  useActivity(
    "sftp-commander",
    inFlight === 0
      ? null
      : inFlight === 1
        ? "SFTP transfer in progress"
        : `SFTP: ${inFlight} transfers in progress`,
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

  const renameEntry = async (target: RenameTarget, newName: string) => {
    const path =
      target.side === "local"
        ? await local.rename(target.entry, newName)
        : await remote.rename(target.entry, newName);
    setReselect((prev) => ({ ...prev, [target.side]: { path } }));
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
            active={visible && activePane === "local"}
            // No mkdir/delete at the drive list (cwd === null).
            onNewFolder={
              local.cwd !== null ? () => setNewFolderSide("local") : undefined
            }
            onDeleteEntry={
              local.cwd !== null
                ? (entry) => setDeleting({ side: "local", entry })
                : undefined
            }
            onRenameEntry={
              local.cwd !== null
                ? (entry) => setRenaming({ side: "local", entry })
                : undefined
            }
            reselect={reselect.local}
            emptyText="Empty folder."
          />
        </div>

        {/* Draggable splitter */}
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startResize}
          data-resize-handle=""
          className="group mx-1 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
          title="Drag to resize"
        >
          <div className="h-10 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary/60" />
        </div>

        {/* RIGHT: remote host. Plain block (not flex) so the FilePane fills the
            full width like the left pane, a flex wrapper would size the pane to
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
              active={visible && activePane === "remote"}
              onNewFolder={() => setNewFolderSide("remote")}
              onDeleteEntry={(entry) => setDeleting({ side: "remote", entry })}
              onRenameEntry={(entry) => setRenaming({ side: "remote", entry })}
              reselect={reselect.remote}
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

      {/* Live progress, one row per transfer under way, with whatever is still
          waiting counted underneath. The rail grows as transfers start and
          shrinks as they finish. Cancel reaches every kind of transfer:
          sftp_upload and sftp_download take the same per-transfer cancel flag
          the recursive walk does, so a large single file is as stoppable as a
          folder is. */}
      {remote.transfers.length > 0 && (
        <div ref={railRef} className="shrink-0">
          <TransferStack
            transfers={remote.transfers}
            onCancel={remote.cancelTransfer}
          />
        </div>
      )}

      {/* New-folder dialog (both sides) */}
      <Dialog
        open={newFolderSide !== null}
        onOpenChange={(o) => !o && setNewFolderSide(null)}
      >
        <DialogContent keepOpenOnOutsideClick>
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

      {/* Rename (both sides) */}
      <RenameDialog
        target={renaming}
        whereLabel={
          renaming?.side === "remote"
            ? `on ${remote.session?.host.label ?? "the host"}`
            : "on this PC"
        }
        onClose={() => setRenaming(null)}
        onRename={renameEntry}
      />

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

      {/* Large-folder confirmation (recursive transfer gate). One dialog at a
          time, taken off the front of the queue as each is answered. */}
      <AlertDialog
        open={pendingDir !== null}
        onOpenChange={(o) => {
          if (!o && pendingDir) answerPendingDir(pendingDir, false);
        }}
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
                  <span className="font-mono text-foreground">
                    {winDirname(pendingDir?.localDest ?? "")}
                  </span>{" "}
                  on this PC
                </>
              )}
              . {clashText(pendingDir?.batch.mode ?? mode)} Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDir) answerPendingDir(pendingDir, true);
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
