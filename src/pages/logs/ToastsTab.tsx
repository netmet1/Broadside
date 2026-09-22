import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HighlightedLine } from "@/components/Highlight";
import { toastDisplayText, type ToastEntry } from "@/lib/tauri/logs";
import { cn } from "@/lib/utils";

import type { useLineSearch } from "./useLineSearch";

/** The colour each kind of toast is drawn in, matching the toasts themselves. */
const KIND_TONE: Record<ToastEntry["kind"], string> = {
  success: "text-emerald-600 dark:text-emerald-400",
  error: "text-red-600 dark:text-red-400",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-foreground",
  message: "text-foreground",
};

const KIND_LABEL: Record<ToastEntry["kind"], string> = {
  success: "Success",
  error: "Error",
  warning: "Warning",
  info: "Info",
  message: "Note",
};

/**
 * Logs > Toasts History: every toast the app has shown, newest first, the last
 * 500 of them. Kept in a file beside the error log, so a restore (which
 * replaces the database) does not take it with it.
 */
export function ToastsTab({
  entries,
  search,
  onRefresh,
  onClear,
  onExport,
}: {
  /** Newest first. */
  entries: ToastEntry[];
  search: ReturnType<typeof useLineSearch>;
  onRefresh: () => void;
  onClear: () => void;
  onExport: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 px-4 py-2">
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCwIcon />
          Refresh
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={entries.length === 0}
          onClick={onClear}
        >
          Clear history
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={entries.length === 0}
          onClick={onExport}
        >
          Export…
        </Button>
        {entries.length > 0 && (
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {entries.length} {entries.length === 1 ? "toast" : "toasts"}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No toasts yet. Every message that pops up in the corner is kept
            here, the last 500 of them, so one that went by too fast can be
            read again.
          </p>
        ) : (
          entries.map((entry, idx) => {
            const matches = search.scan?.perLine.get(idx) ?? null;
            if (search.filterActive && !matches) return null;
            const isActiveLine = search.activeHit?.lineIdx === idx;
            const display = toastDisplayText(entry);
            return (
              <div
                key={idx}
                className={cn(
                  "flex items-baseline gap-3 py-0.5 font-mono text-xs",
                  search.findActive && !matches && "opacity-40",
                )}
              >
                <span className="shrink-0 text-muted-foreground">
                  {entry.ts ? new Date(entry.ts).toLocaleString() : "-"}
                </span>
                <span className={cn("w-14 shrink-0", KIND_TONE[entry.kind])}>
                  {KIND_LABEL[entry.kind] ?? entry.kind}
                </span>
                <pre
                  className={cn(
                    "whitespace-pre-wrap break-words",
                    KIND_TONE[entry.kind],
                  )}
                >
                  {matches && search.mode !== null ? (
                    <HighlightedLine
                      text={display}
                      matches={matches}
                      activeRange={isActiveLine ? search.activeHit!.match : null}
                    />
                  ) : (
                    display
                  )}
                </pre>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
