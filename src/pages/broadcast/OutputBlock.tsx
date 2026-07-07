import {
  ChevronDownIcon,
  ChevronRightIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { type ExecResult } from "@/lib/tauri/broadcast";
import { type Matcher } from "@/lib/search";
import type { PresentedKey } from "@/lib/tauri/ssh";
import { HighlightedLine, HighlightedText } from "@/components/Highlight";
import {
  type Block,
  type FindData,
  filteredLines,
  statusSummary,
} from "@/pages/broadcast/model";

export function OutputBlock({
  block,
  blockKey,
  showHeader,
  findData,
  filterMatcher,
  onToggle,
  onReviewMismatch,
  onRetry,
}: {
  block: Block;
  blockKey: string;
  /** When false, hide the per-host header (output only, color-tinted). */
  showHeader: boolean;
  findData: FindData | null;
  filterMatcher: Matcher | null;
  onToggle: () => void;
  onReviewMismatch: (stored: string, presented: PresentedKey) => void;
  /** Re-run this host with the run's command. Undefined while a run is in
   * flight (disables the per-block Retry button). */
  onRetry?: () => void;
}) {
  // With headers hidden there's no collapse affordance, so always show output;
  // a coloured left border keeps each host's block identifiable.
  const bodyShown = !showHeader || !block.collapsed;
  const tintBorder = showHeader
    ? undefined
    : { borderLeftColor: block.color, borderLeftWidth: 3 };
  const { result } = block;
  const summary = statusSummary(result);
  const toneClass =
    summary.tone === "ok"
      ? "text-emerald-400"
      : summary.tone === "warn"
        ? "text-amber-400"
        : "text-red-400";

  // Filter mode: a completed block with zero matching lines collapses to a
  // summary row (D-015).
  if (filterMatcher && result.status === "completed") {
    const matchingLines = filteredLines(result, filterMatcher);
    if (matchingLines.length === 0) {
      return (
        <div className="flex items-center gap-2 rounded-md border border-border/30 px-3 py-1.5 text-xs text-muted-foreground">
          <span
            className="h-2 w-2 shrink-0 rounded-full opacity-50"
            style={{ backgroundColor: block.color }}
          />
          {block.label}: 0 matches
        </div>
      );
    }
    return (
      <div
        className="overflow-hidden rounded-md border border-border/40"
        style={tintBorder}
      >
        {showHeader && (
          <BlockHeader
            block={block}
            summaryText={summary.text}
            toneClass={toneClass}
            onToggle={onToggle}
          />
        )}
        {bodyShown && (
          <div className="px-3 pb-3 font-mono text-xs">
            {matchingLines.map((l, i) => (
              <pre
                key={i}
                className={`whitespace-pre-wrap break-words ${l.stream === "stderr" ? "text-red-400/90" : ""}`}
              >
                <HighlightedLine
                  text={l.text}
                  matches={l.matches}
                  activeRange={null}
                />
              </pre>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-border/40"
      style={tintBorder}
    >
      {showHeader && (
        <BlockHeader
          block={block}
          summaryText={summary.text}
          toneClass={toneClass}
          onToggle={onToggle}
        />
      )}
      {bodyShown && (
        <div className="px-3 pb-3">
          <BlockBody
            result={result}
            blockKey={blockKey}
            findData={findData}
            onReviewMismatch={onReviewMismatch}
            onRetry={onRetry}
          />
        </div>
      )}
    </div>
  );
}

function BlockHeader({
  block,
  summaryText,
  toneClass,
  onToggle,
}: {
  block: Block;
  summaryText: string;
  toneClass: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40"
    >
      {block.collapsed ? (
        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: block.color }}
      />
      <span className="font-medium">{block.label}</span>
      <span className={`ml-auto font-mono text-xs ${toneClass}`}>
        {summaryText}
      </span>
    </button>
  );
}

/** Small "re-run just this host" button shown on failed/timed-out blocks. */
function RetryButton({ onRetry }: { onRetry?: () => void }) {
  if (!onRetry) return null;
  return (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <RotateCwIcon />
      Retry
    </Button>
  );
}

function BlockBody({
  result,
  blockKey,
  findData,
  onReviewMismatch,
  onRetry,
}: {
  result: ExecResult;
  blockKey: string;
  findData: FindData | null;
  onReviewMismatch: (stored: string, presented: PresentedKey) => void;
  onRetry?: () => void;
}) {
  switch (result.status) {
    case "completed":
      return (
        <div className="space-y-2 font-mono text-xs">
          {(["stdout", "stderr"] as const).map((stream) => {
            const text = result[stream];
            if (!text) return null;
            const lineMap = findData?.byRef.get(`${blockKey}:${stream}`);
            const activeHere =
              findData?.activeHit?.key === blockKey &&
              findData.activeHit.stream === stream;
            return (
              <pre
                key={stream}
                className={`whitespace-pre-wrap break-words ${stream === "stderr" ? "text-red-400/90" : ""}`}
              >
                {lineMap ? (
                  <HighlightedText
                    text={text}
                    lineMap={lineMap}
                    activeLine={activeHere ? findData!.activeHit!.line : null}
                    activeRange={
                      activeHere
                        ? {
                            start: findData!.activeHit!.start,
                            end: findData!.activeHit!.end,
                          }
                        : null
                    }
                  />
                ) : (
                  text
                )}
              </pre>
            );
          })}
          {!result.stdout && !result.stderr && (
            <p className="text-muted-foreground">(no output)</p>
          )}
          {result.timed_out && (
            <div className="space-y-2">
              <p className="text-red-400">[TIMEOUT: partial output above]</p>
              <RetryButton onRetry={onRetry} />
            </div>
          )}
        </div>
      );
    case "unknown_key":
      return (
        <p className="text-xs text-muted-foreground">
          First contact with this host. Trust its key in the dialog to
          proceed.
        </p>
      );
    case "key_mismatch":
      return (
        <div className="space-y-2 text-xs">
          <p className="flex items-center gap-1.5 text-red-400">
            <TriangleAlertIcon className="h-3.5 w-3.5" />
            The server's key does not match the stored fingerprint. Connection
            refused.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onReviewMismatch(result.stored_fingerprint, result.presented)
            }
          >
            Review…
          </Button>
        </div>
      );
    case "auth_failed":
    case "unreachable":
      return (
        <div className="space-y-2">
          <p className="text-xs text-red-400/90">{result.message}</p>
          <RetryButton onRetry={onRetry} />
        </div>
      );
    case "no_credentials":
      return (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No credentials stored. Edit the host on the Hosts page.
          </p>
          <RetryButton onRetry={onRetry} />
        </div>
      );
  }
}
