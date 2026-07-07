import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
  FileUpIcon,
  FolderUpIcon,
  MonitorIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SendIcon,
  ServerIcon,
  TriangleAlertIcon,
} from "lucide-react";

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
import { BatchTofuDialog } from "@/components/BatchTofuDialog";
import type { Host } from "@/lib/tauri/hosts";
import type { TransferMode } from "@/lib/tauri/sftp";
import { RAIL_SORT_OPTIONS, sortForRail } from "@/lib/railSort";
import { cn } from "@/lib/utils";
import { wordInitials } from "@/pages/broadcast/model";
import { BroadcastOutputLine } from "@/pages/sftp/BroadcastOutputLine";
import { useSftpBroadcast } from "@/pages/sftp/useSftpBroadcast";

/** Persisted Local↔Remote split (percent width of the Local box). */
const SPLIT_KEY = "sftp-broadcast-split";

/**
 * SFTP Broadcast: put/get a file or folder across many hosts at once. The remote
 * side is always the multi-host side, so its box carries the manual path input
 * and the scrolling per-host progress list; the local side offers a native
 * picker. A typed-word guard gates the (potentially wide-reaching) transfer.
 */
export function BroadcastTab({
  visible,
  mode,
}: {
  visible: boolean;
  mode: TransferMode;
}) {
  const b = useSftpBroadcast(visible, mode);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const railHosts = useMemo(
    () => sortForRail(b.hosts, (h) => h, b.railSort),
    [b.hosts, b.railSort],
  );

  // Auto-scroll the output to the bottom as lines stream, but release the follow
  // when the user scrolls up to review earlier progress bars (mirrors Broadcast).
  const outputRef = useRef<HTMLDivElement>(null);
  const outputContentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const autoScrollUntilRef = useRef(0);
  useEffect(() => {
    const scroller = outputRef.current;
    const content = outputContentRef.current;
    if (!scroller || !content) return;
    const stick = () => {
      if (!atBottomRef.current) return;
      autoScrollUntilRef.current = performance.now() + 150;
      scroller.scrollTop = scroller.scrollHeight;
    };
    const ro = new ResizeObserver(stick);
    ro.observe(content);
    stick();
    return () => ro.disconnect();
  }, [b.results]);
  const onOutputScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    if (performance.now() < autoScrollUntilRef.current) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  const startTransfer = () => {
    atBottomRef.current = true; // re-follow output on a fresh run
    b.runTransfer();
  };

  // Draggable split between the Local and Remote boxes (Local width, in %).
  const splitRowRef = useRef<HTMLDivElement>(null);
  const [splitPct, setSplitPct] = useState(() => {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v >= 20 && v <= 80 ? v : 50;
  });
  const startSplitResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const row = splitRowRef.current;
    if (!row) return;
    const onMove = (me: MouseEvent) => {
      const rect = row.getBoundingClientRect();
      const pct = ((me.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSplitPct((p) => {
        localStorage.setItem(SPLIT_KEY, String(Math.round(p)));
        return p;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const isPut = b.direction === "put";
  const localCaption = isPut ? "source" : "destination";
  const remoteCaption = isPut ? "destination" : "source";

  const hostsById = useMemo(() => {
    const m = new Map<number, Host>();
    for (const h of b.hosts) m.set(h.id, h);
    return m;
  }, [b.hosts]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Danger banner. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-amber-300/70 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
        <TriangleAlertIcon className="h-4 w-4 shrink-0" />
        <span>
          Broadcasting file transfers writes to every selected host at once and
          can overwrite or displace data widely. Proceed only if you understand
          exactly what will be transferred and where.
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Host selection rail (collapsible — mirrors the other broadcast pages). */}
        <div
          className={cn(
            "flex shrink-0 flex-col border-r border-border/50",
            b.railCollapsed ? "w-14" : "w-60",
          )}
        >
          <div className="flex shrink-0 items-center gap-2 px-2 py-2">
            <button
              type="button"
              onClick={b.toggleRail}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              aria-label={b.railCollapsed ? "Expand host rail" : "Collapse host rail"}
            >
              {b.railCollapsed ? (
                <PanelLeftOpenIcon className="h-4 w-4" />
              ) : (
                <PanelLeftCloseIcon className="h-4 w-4" />
              )}
            </button>
            {!b.railCollapsed && (
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={b.allSelected}
                  onChange={b.toggleAll}
                  disabled={b.running || b.hosts.length === 0}
                />
                Select all
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {b.selected.size}/{b.hosts.length}
                </span>
              </label>
            )}
          </div>
          {!b.railCollapsed && (
            <div className="shrink-0 px-3 pb-2">
              <select
                value={b.railSort}
                onChange={(e) => b.setRailSort(e.target.value)}
                aria-label="Sort hosts"
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:border-ring"
              >
                {RAIL_SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    Sort: {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {railHosts.map((h) => {
              const st = b.results.get(h.id)?.status;
              const dot =
                st === "ok"
                  ? "bg-emerald-500"
                  : st === "fail"
                    ? "bg-red-500"
                    : st === "running"
                      ? "bg-amber-500"
                      : null;
              return b.railCollapsed ? (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => b.toggleHost(h.id)}
                  disabled={b.running}
                  title={h.label}
                  className={cn(
                    "mb-1 flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 hover:bg-accent/50",
                    b.selected.has(h.id) ? "bg-accent/40 ring-1 ring-primary/50" : "",
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: h.color }}
                  />
                  <span className="font-mono text-[10px] leading-none">
                    {wordInitials(h.label)}
                  </span>
                </button>
              ) : (
                <label
                  key={h.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={b.selected.has(h.id)}
                    onChange={() => b.toggleHost(h.id)}
                    disabled={b.running}
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: h.color }}
                  />
                  <span className="min-w-0 truncate" title={h.label}>
                    {h.label}
                  </span>
                  {dot && <span className={cn("ml-auto h-2 w-2 shrink-0 rounded-full", dot)} />}
                </label>
              );
            })}
            {b.hosts.length === 0 && !b.railCollapsed && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No hosts yet. Add hosts on the Hosts page first.
              </p>
            )}
          </div>
          {!b.railCollapsed && (
            <div className="shrink-0 border-t border-border/50 p-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={b.clearResults}
                disabled={b.runHostIds.length === 0 || b.running}
              >
                Clear results
              </Button>
            </div>
          )}
        </div>

        {/* Main column: options, direction selector, source/destination boxes. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="text-xs text-muted-foreground">
            A <span className="font-medium text-foreground">get</span> (remote →
            local) creates one folder per host label under the chosen local
            destination and places each host's copy inside it.
          </p>

          {/* Create-path toggle (session-only, off by default). */}
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              checked={b.createPath}
              onChange={(e) => b.setCreatePath(e.target.checked)}
              disabled={b.running}
            />
            Create path if it doesn't exist
            <span className="text-xs text-muted-foreground">
              (put only — resets on restart)
            </span>
          </label>

          {/* Direction selector: the Local graphic sits over the Local box and
              the Remote graphic over the Remote box, while the PUT/GET toggle
              floats over the draggable divider — so it tracks the split live as
              the user drags it. */}
          <div className="relative flex items-stretch rounded-lg border border-border/50 bg-muted/20 py-3">
            <div style={{ width: `${splitPct}%` }} className="flex justify-center">
              <DirectionEnd
                icon={<MonitorIcon className="h-6 w-6" />}
                title="Local"
                caption={localCaption}
              />
            </div>
            <div className="flex flex-1 justify-center">
              <DirectionEnd
                icon={<ServerIcon className="h-6 w-6" />}
                title="Remote"
                caption={remoteCaption}
              />
            </div>
            <button
              type="button"
              onClick={() => b.setDirection(isPut ? "get" : "put")}
              disabled={b.running}
              aria-label="Swap transfer direction"
              title="Swap source and destination"
              style={{ left: `${splitPct}%` }}
              className="absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-accent/50 disabled:opacity-50"
            >
              <ArrowLeftRightIcon className="h-4 w-4" />
              {isPut ? "PUT" : "GET"}
            </button>
          </div>

          {/* Source/destination boxes. Local always browses; remote always holds
              the manual path input + the per-host progress output. */}
          <div ref={splitRowRef} className="flex min-h-0 flex-1">
            {/* LOCAL box */}
            <div
              style={{ width: `${splitPct}%` }}
              className="flex min-h-0 min-w-0 flex-col gap-2 rounded-lg border border-border/50 p-3"
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <MonitorIcon className="h-4 w-4 text-muted-foreground" />
                Local
                <span className="text-xs font-normal uppercase tracking-wide text-muted-foreground">
                  {localCaption}
                </span>
                {/* Flow direction: → data leaves local (PUT), ← data arrives (GET). */}
                <span
                  className="ml-auto flex items-center rounded-md bg-primary/10 px-1.5 py-1 text-primary"
                  title={isPut ? "Sending to remote (PUT)" : "Receiving from remote (GET)"}
                >
                  {isPut ? (
                    <ArrowRightIcon className="h-5 w-5" strokeWidth={2.75} />
                  ) : (
                    <ArrowLeftIcon className="h-5 w-5" strokeWidth={2.75} />
                  )}
                </span>
              </div>
              <div className="flex gap-2">
                {isPut && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={b.pickLocalFile}
                    disabled={b.running}
                  >
                    <FileUpIcon className="mr-1 h-4 w-4" /> Browse file…
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={b.pickLocalFolder}
                  disabled={b.running}
                >
                  <FolderUpIcon className="mr-1 h-4 w-4" /> Browse folder…
                </Button>
              </div>
              <Input
                value={b.localPath}
                readOnly
                placeholder="No file or folder selected"
                className="font-mono text-xs"
                title={b.localPath}
              />
              {b.localPath && (
                <p className="text-xs text-muted-foreground">
                  {b.localIsDir ? "Folder" : "File"} selected.
                </p>
              )}
            </div>

            {/* Drag handle: resize the Local ↔ Remote split. */}
            <div
              onMouseDown={startSplitResize}
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
              className="mx-1.5 w-1.5 shrink-0 cursor-col-resize self-stretch rounded-full border-x border-border/40 hover:border-primary hover:bg-primary/20"
            />

            {/* REMOTE box (manual path + per-host progress output) */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border/50 p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ServerIcon className="h-4 w-4 text-muted-foreground" />
                Remote
                <span className="text-xs font-normal uppercase tracking-wide text-muted-foreground">
                  {remoteCaption}
                </span>
              </div>
              <Input
                value={b.remotePath}
                onChange={(e) => b.setRemotePath(e.target.value)}
                placeholder={isPut ? "/remote/destination/dir" : "/remote/source/path"}
                className="font-mono text-xs"
                disabled={b.running}
              />
              <div
                ref={outputRef}
                onScroll={onOutputScroll}
                className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/40 bg-muted/10 p-2"
              >
                <div ref={outputContentRef} className="space-y-1">
                  {b.runHostIds.length === 0 ? (
                    <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                      Per-host transfer progress will appear here.
                    </p>
                  ) : (
                    b.runHostIds.map((id) => {
                      const host = hostsById.get(id);
                      const xfer = b.results.get(id);
                      if (!host || !xfer) return null;
                      return (
                        <BroadcastOutputLine key={id} host={host} xfer={xfer} />
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Transfer action. */}
          <div className="flex shrink-0 items-center gap-3">
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={!b.canRun}
              title={
                b.canRun
                  ? undefined
                  : "Select hosts, choose a local file/folder, and enter a remote path"
              }
            >
              <SendIcon className="mr-1 h-4 w-4" />
              {isPut ? "Transfer (PUT)" : "Transfer (GET)"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {b.selected.size} host{b.selected.size === 1 ? "" : "s"} selected
            </span>
          </div>
        </div>
      </div>

      {/* Typed-word confirmation guard. */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <ConfirmBody
          open={confirmOpen}
          isPut={isPut}
          count={b.selected.size}
          onConfirmed={() => {
            setConfirmOpen(false);
            startTransfer();
          }}
        />
      </AlertDialog>

      {/* Batch host-key trust for first-seen hosts, then retry them. */}
      <BatchTofuDialog
        open={b.tofuOpen}
        onOpenChange={b.setTofuOpen}
        entries={b.tofuEntries}
        onTrusted={b.retryHosts}
      />
    </div>
  );
}

function DirectionEnd({
  icon,
  title,
  caption,
}: {
  icon: React.ReactNode;
  title: string;
  caption: string;
}) {
  return (
    // Fixed width so the source/destination caption swap doesn't reflow the row
    // and shove the PUT/GET toggle sideways — only the words change in place.
    <div className="flex w-28 flex-col items-center gap-1 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {caption}
      </span>
    </div>
  );
}

/** Type-CONFIRM gate before a broadcast transfer runs. */
function ConfirmBody({
  open,
  isPut,
  count,
  onConfirmed,
}: {
  open: boolean;
  isPut: boolean;
  count: number;
  onConfirmed: () => void;
}) {
  const [typed, setTyped] = useState("");
  const armed = typed === "CONFIRM";
  // The dialog stays mounted while closed, so clear the typed word each time it
  // closes — a destructive broadcast must be re-confirmed from scratch every run.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2 text-destructive">
          <TriangleAlertIcon className="h-5 w-5" />
          Broadcast {isPut ? "PUT" : "GET"}
        </AlertDialogTitle>
        <AlertDialogDescription>
          This will {isPut ? "upload to" : "download from"}{" "}
          <span className="font-semibold text-foreground">
            {count} {count === 1 ? "host" : "hosts"}
          </span>
          . {isPut
            ? "Files may overwrite existing data on every selected host."
            : "One folder per host label is created locally."}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="space-y-2">
        <Label htmlFor="sftp-confirm" className="text-xs font-normal">
          Type <span className="font-mono font-semibold">CONFIRM</span> to enable
          Transfer (case-sensitive)
        </Label>
        <Input
          id="sftp-confirm"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
      </div>
      <AlertDialogFooter>
        <AlertDialogAction
          variant="destructive"
          disabled={!armed}
          onClick={onConfirmed}
        >
          Transfer
        </AlertDialogAction>
        <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
