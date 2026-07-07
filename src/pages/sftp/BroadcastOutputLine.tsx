import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";

import type { Host } from "@/lib/tauri/hosts";
import { cn } from "@/lib/utils";
import type { HostXfer } from "@/pages/sftp/useSftpBroadcast";
import { formatSize } from "@/pages/sftp/model";

/** One per-host transfer line: status icon, host-colour dot, label, a live
 *  progress bar, and a byte/status summary — the SFTP analogue of the PTY
 *  Broadcast result row. */
export function BroadcastOutputLine({
  host,
  xfer,
}: {
  host: Host;
  xfer: HostXfer;
}) {
  const pct =
    xfer.bytesTotal > 0
      ? Math.min(100, Math.round((xfer.bytesDone / xfer.bytesTotal) * 100))
      : xfer.status === "ok"
        ? 100
        : 0;

  const barColor =
    xfer.status === "ok"
      ? "bg-emerald-500"
      : xfer.status === "fail"
        ? "bg-red-500"
        : "bg-primary";

  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 px-3 py-1.5 text-sm">
      {xfer.status === "ok" ? (
        <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
      ) : xfer.status === "fail" ? (
        <XIcon className="h-4 w-4 shrink-0 text-red-400" />
      ) : xfer.status === "running" ? (
        <Loader2Icon className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />
      )}
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: host.color }}
      />
      <span className="min-w-0 shrink-0 basis-32 truncate font-medium" title={host.label}>
        {host.label}
      </span>

      {/* Progress bar — fills as bytes stream; indeterminate look while pending. */}
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width] duration-150", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>

      <span
        className={cn(
          "ml-auto shrink-0 font-mono text-xs",
          xfer.status === "ok"
            ? "text-emerald-400"
            : xfer.status === "fail"
              ? "text-red-400"
              : "text-muted-foreground",
        )}
      >
        {xfer.status === "fail"
          ? (xfer.message ?? "failed")
          : xfer.status === "ok"
            ? (xfer.message ?? "done")
            : xfer.bytesTotal > 0
              ? `${formatSize(xfer.bytesDone)} / ${formatSize(xfer.bytesTotal)}`
              : xfer.status === "running"
                ? "transferring…"
                : "queued"}
      </span>
    </div>
  );
}
