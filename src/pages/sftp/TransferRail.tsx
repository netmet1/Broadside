import { useState } from "react";
import { Loader2Icon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";
import { formatSize } from "@/pages/sftp/model";
import { type ActiveTransfer } from "@/pages/sftp/useSftpBrowser";

/**
 * Bottom rail showing every transfer under way, one bar each, plus a count of
 * what is still waiting for a slot.
 *
 * It grows a row when a transfer starts and loses one when it finishes, so a
 * drop of several files reads as several bars settling down to none. Only the
 * running ones get a bar: the queue is capped, so the height is bounded whether
 * three files were dropped or three hundred, and a hundred identical bars
 * reading 0% would say less than one line saying how many are left.
 */
export function TransferStack({
  transfers,
  onCancel,
}: {
  transfers: ActiveTransfer[];
  onCancel: (transferId?: string) => void;
}) {
  const hint = useHint();
  // Scans get a row too: a big folder can take a while to count, and it needs
  // a Cancel of its own while it does.
  const shown = transfers.filter((t) => t.status !== "queued");
  const queued = transfers.length - shown.length;
  return (
    <div className="shrink-0 space-y-1.5 border-t border-border/50 px-3 py-2">
      {shown.map((t) => (
        <TransferRow key={t.transferId} transfer={t} onCancel={onCancel} />
      ))}
      {queued > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {queued} more {queued === 1 ? "transfer" : "transfers"} waiting
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-destructive"
            onClick={() => onCancel()}
            {...hint("Stop every transfer and clear the ones still waiting")}
          >
            <XIcon />
            Cancel all
          </Button>
        </div>
      )}
    </div>
  );
}

/** One transfer's row: what it is, how far along, and a way to stop it. Covers
 *  both a recursive folder and a single file; the file counter is what tells
 *  them apart on screen. */
function TransferRow({
  transfer,
  onCancel,
}: {
  transfer: ActiveTransfer;
  onCancel: (transferId?: string) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const pct =
    transfer.bytesTotal > 0
      ? Math.min(100, (transfer.bytesDone / transfer.bytesTotal) * 100)
      : transfer.filesTotal > 0
        ? Math.min(100, (transfer.filesDone / transfer.filesTotal) * 100)
        : null;
  // One file has no file count worth showing. The backend reports files_done: 0
  // for the whole of a single-file transfer, since nothing has finished until
  // everything has, so the counter would read `0/1 files` from start to end and
  // then vanish. The bytes are the story here; let them have the room.
  const single = transfer.filesTotal === 1;
  // A folder still being counted has no numbers yet, only a name and a Cancel.
  const scanning = transfer.status === "scanning";
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-xs">
        <Loader2Icon className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="min-w-0 truncate font-medium">
          {scanning
            ? "Scanning"
            : transfer.direction === "put"
              ? "Uploading"
              : "Downloading"}{" "}
          <span className="font-mono">{transfer.name}</span>
          {scanning && "…"}
        </span>
        <span
          className={cn(
            "shrink-0 tabular-nums text-muted-foreground",
            scanning && "hidden",
          )}
        >
          {!single && (
            <>
              {transfer.filesDone}
              {transfer.filesTotal ? `/${transfer.filesTotal}` : ""} files ·{" "}
            </>
          )}
          {formatSize(transfer.bytesDone)}
          {transfer.bytesTotal ? ` / ${formatSize(transfer.bytesTotal)}` : ""}
          {pct !== null ? ` · ${Math.round(pct)}%` : ""}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto shrink-0 text-destructive"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            onCancel(transfer.transferId);
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
