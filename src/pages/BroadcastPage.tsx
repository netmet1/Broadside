import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Composer } from "@/components/Composer";
import { ConfirmDestructiveDialog } from "@/components/ConfirmDestructiveDialog";
import {
  BatchTofuDialog,
  type UnknownKeyEntry,
} from "@/components/BatchTofuDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import { SearchBar, type SearchMode } from "@/components/SearchBar";
import {
  type ExecResult,
  type GuardHit,
  type HostExecReport,
  broadcastCommand,
  checkDestructive,
  onBroadcastResult,
} from "@/lib/tauri/broadcast";
import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
import { commandHistory, getAppSettings } from "@/lib/tauri/settings";
import type { PresentedKey } from "@/lib/tauri/ssh";
import {
  buildMatcher,
  isMatcher,
  matchLine,
  type LineMatch,
  type Matcher,
  type SearchOptions,
} from "@/lib/search";
import { HighlightedLine, HighlightedText } from "@/components/Highlight";
import { SaveSessionDialog } from "@/components/SaveSessionDialog";
import type { OtlogLine } from "@/lib/tauri/logs";
import { useHint, usePageStatus } from "@/lib/status";

const DEFAULT_TIMEOUT_SECS = 30;

type Block = HostExecReport & { collapsed: boolean; receivedAt: string };

type StreamRef = { hostId: number; stream: "stdout" | "stderr" };

/** One navigable find hit (a single match occurrence). */
type FindHit = StreamRef & { line: number; start: number; end: number };

export function BroadcastPage({ visible }: { visible: boolean }) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [command, setCommand] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(String(DEFAULT_TIMEOUT_SECS));
  const [running, setRunning] = useState(false);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [pendingHosts, setPendingHosts] = useState<Set<number>>(new Set());
  const [guardHits, setGuardHits] = useState<GuardHit[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tofuEntries, setTofuEntries] = useState<UnknownKeyEntry[]>([]);
  const [tofuOpen, setTofuOpen] = useState(false);
  const [mismatch, setMismatch] = useState<{
    host: Host;
    stored: string;
    presented: PresentedKey;
  } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  // Up/Down recall in the composer, newest first (persisted via migration 6).
  const [history, setHistory] = useState<string[]>([]);

  // Search (D-015): Ctrl+F find, Ctrl+Shift+F filter.
  const [searchMode, setSearchMode] = useState<SearchMode | null>(null);
  const [searchPattern, setSearchPattern] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions | null>(
    null,
  );
  const [activeHitIdx, setActiveHitIdx] = useState(0);

  const hint = useHint();

  usePageStatus(
    hosts.length > 0
      ? `${selected.size}/${hosts.length} hosts selected`
      : null,
    visible,
  );

  const runIdRef = useRef<string>("");
  const lastCommandRef = useRef<string>("");
  const lastConfirmedRef = useRef<boolean>(false);
  const outputRef = useRef<HTMLDivElement>(null);

  const hostsById = useMemo(() => {
    const map = new Map<number, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);

  // Hosts known from the previous refresh — lets us tell "new host" (gets
  // the selected-by-default treatment) from "existing host the user
  // deselected" (selection preserved) when re-syncing on page return.
  const knownHostIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!visible) return;
    listHosts()
      .then((all) => {
        setHosts(all);
        setSelected((prev) => {
          const next = new Set<number>();
          for (const h of all) {
            // Pre-select everything new — broadcast-to-all is the common
            // case; keep the user's choices for hosts they've already seen.
            if (!knownHostIds.current.has(h.id) || prev.has(h.id)) {
              next.add(h.id);
            }
          }
          knownHostIds.current = new Set(all.map((h) => h.id));
          return next;
        });
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, [visible]);

  useEffect(() => {
    commandHistory(100)
      .then((entries) => setHistory(entries.map((e) => e.command)))
      .catch(() => {
        // Recall is a convenience; the composer works without it.
      });
    getAppSettings()
      .then((s) => setTimeoutSecs(String(s.default_timeout_secs)))
      .catch(() => {
        // Keep the built-in 30s default if settings can't load.
      });
  }, []);

  useEffect(() => {
    const unlisten = onBroadcastResult((report) => {
      if (report.run_id !== runIdRef.current) return;
      setPendingHosts((prev) => {
        const next = new Set(prev);
        next.delete(report.host_id);
        return next;
      });
      setBlocks((prev) => [
        // A retry replaces the host's previous block.
        ...prev.filter((b) => b.host_id !== report.host_id),
        { ...report, collapsed: false, receivedAt: new Date().toISOString() },
      ]);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    // Don't yank the scroll position around while the user is searching.
    if (searchMode === null) {
      outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
    }
  }, [blocks, searchMode]);

  // Keyboard entry points (D-015). Only while this page is the visible one —
  // the component stays mounted in the background after navigation.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchMode(e.shiftKey ? "filter" : "find");
        setActiveHitIdx(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const closeSearch = useCallback(() => {
    setSearchMode(null);
    setSearchPattern("");
    setSearchOptions(null);
    setActiveHitIdx(0);
  }, []);

  const matcherOrError = useMemo(
    () =>
      searchMode !== null && searchOptions !== null
        ? buildMatcher(searchPattern, searchOptions)
        : null,
    [searchMode, searchPattern, searchOptions],
  );
  const matcher = isMatcher(matcherOrError) ? matcherOrError : null;

  /** Per-stream line matches for every completed block, in display order. */
  const scan = useMemo(() => {
    if (!matcher) return null;
    const byRef = new Map<string, Map<number, LineMatch[]>>();
    const hits: FindHit[] = [];
    const hostsWithMatches = new Set<number>();
    let total = 0;
    for (const block of blocks) {
      if (block.result.status !== "completed") continue;
      for (const stream of ["stdout", "stderr"] as const) {
        const text = block.result[stream];
        if (!text) continue;
        const lines = text.split("\n");
        const lineMap = new Map<number, LineMatch[]>();
        for (let i = 0; i < lines.length; i++) {
          const matches = matchLine(matcher, lines[i]);
          if (matches.length > 0) {
            lineMap.set(i, matches);
            hostsWithMatches.add(block.host_id);
            total += matches.length;
            for (const m of matches) {
              hits.push({ hostId: block.host_id, stream, line: i, ...m });
            }
          }
        }
        if (lineMap.size > 0) {
          byRef.set(`${block.host_id}:${stream}`, lineMap);
        }
      }
    }
    return { byRef, hits, total, hostCount: hostsWithMatches.size };
  }, [matcher, blocks]);

  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (!scan || scan.hits.length === 0) return;
      setActiveHitIdx(
        (idx) => (idx + direction + scan.hits.length) % scan.hits.length,
      );
    },
    [scan],
  );

  useEffect(() => {
    setActiveHitIdx(0);
  }, [searchPattern, searchOptions]);

  const searchStatus = (() => {
    if (matcherOrError && "error" in matcherOrError) {
      return { text: matcherOrError.error, tone: "error" as const };
    }
    if (!scan || searchPattern === "") return { text: "", tone: "normal" as const };
    if (scan.total === 0) return { text: "No matches", tone: "normal" as const };
    const base = `${scan.total} ${scan.total === 1 ? "match" : "matches"} in ${scan.hostCount} ${scan.hostCount === 1 ? "host" : "hosts"}`;
    return {
      text:
        searchMode === "find"
          ? `${scan.hits.length === 0 ? 0 : activeHitIdx + 1}/${scan.hits.length} · ${base}`
          : base,
      tone: "normal" as const,
    };
  })();

  const allSelected = hosts.length > 0 && selected.size === hosts.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(hosts.map((h) => h.id)));
  };
  const toggleHost = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const parsedTimeout = (() => {
    const n = Number(timeoutSecs);
    return Number.isFinite(n) && n >= 1 && n <= 3600 ? Math.floor(n) : null;
  })();

  const runBroadcast = useCallback(
    async (hostIds: number[], cmd: string, confirmed: boolean) => {
      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      lastCommandRef.current = cmd;
      lastConfirmedRef.current = confirmed;
      // Mirror the backend's history write (consecutive duplicates collapse).
      setHistory((prev) => (prev[0] === cmd ? prev : [cmd, ...prev]));
      setRunning(true);
      setPendingHosts(new Set(hostIds));
      try {
        const reports = await broadcastCommand({
          runId,
          hostIds,
          command: cmd,
          timeoutSecs: parsedTimeout ?? DEFAULT_TIMEOUT_SECS,
          confirmed,
        });
        const unknown: UnknownKeyEntry[] = [];
        for (const r of reports) {
          if (r.result.status === "unknown_key") {
            const host = hostsById.get(r.host_id);
            if (host) {
              unknown.push({
                hostId: host.id,
                label: host.label,
                hostname: host.hostname,
                port: host.port,
                key: r.result.key,
              });
            }
          }
        }
        if (unknown.length > 0) {
          setTofuEntries(unknown);
          setTofuOpen(true);
        }
      } catch (e) {
        toast.error(errorMessage(e));
        setPendingHosts(new Set());
      } finally {
        setRunning(false);
      }
    },
    [hostsById, parsedTimeout],
  );

  const send = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || selected.size === 0 || running || parsedTimeout === null) {
      return;
    }
    setBlocks([]);
    try {
      const hits = await checkDestructive(cmd);
      if (hits.length > 0) {
        setGuardHits(hits);
        setConfirmOpen(true);
        return;
      }
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    runBroadcast([...selected], cmd, false);
  }, [command, selected, running, parsedTimeout, runBroadcast]);

  const retryHosts = useCallback(
    (hostIds: number[]) => {
      runBroadcast(hostIds, lastCommandRef.current, lastConfirmedRef.current);
    },
    [runBroadcast],
  );

  const toggleCollapsed = (hostId: number) => {
    setBlocks((prev) =>
      prev.map((b) =>
        b.host_id === hostId ? { ...b, collapsed: !b.collapsed } : b,
      ),
    );
  };

  const waitingLabels = [...pendingHosts]
    .map((id) => hostsById.get(id)?.label ?? `#${id}`)
    .join(", ");

  /** Current output as .otlog lines (D-010): per output line, plus a status
   * line per host so failures are part of the record. */
  const buildOtlogLines = useCallback((): OtlogLine[] => {
    const out: OtlogLine[] = [];
    for (const block of blocks) {
      out.push({
        ts: block.receivedAt,
        host: block.label,
        stream: "status",
        data: statusSummary(block.result).text,
      });
      if (block.result.status !== "completed") continue;
      for (const stream of ["stdout", "stderr"] as const) {
        const text = block.result[stream];
        if (!text) continue;
        for (const line of text.split("\n")) {
          out.push({ ts: block.receivedAt, host: block.label, stream, data: line });
        }
      }
    }
    return out;
  }, [blocks]);

  const activeHit =
    searchMode === "find" && scan && scan.hits.length > 0
      ? scan.hits[Math.min(activeHitIdx, scan.hits.length - 1)]
      : null;

  const filterActive = searchMode === "filter" && matcher !== null && searchPattern !== "";

  return (
    <div className="flex h-full flex-col">
      {/* Static reminder of the exec-channel contract (D-002). */}
      <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300/90">
        The broadcast channel is exclusively for non-interactive commands that
        print output and exit.
      </div>
      <div className="flex min-h-0 flex-1">
      {/* Host selection rail */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border/50">
        <label
          className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium"
          {...hint("Select or deselect every host for this broadcast")}
        >
          <input
            type="checkbox"
            className="accent-primary"
            checked={allSelected}
            onChange={toggleAll}
            disabled={running}
          />
          Select all
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {selected.size}/{hosts.length}
          </span>
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {hosts.map((h) => (
            <label
              key={h.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={selected.has(h.id)}
                onChange={() => toggleHost(h.id)}
                disabled={running}
              />
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: h.color }}
              />
              <span className="truncate">{h.label}</span>
            </label>
          ))}
          {hosts.length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No hosts configured. Add hosts on the Hosts page first.
            </p>
          )}
        </div>
      </div>

      {/* Output + composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        {searchMode !== null && (
          <SearchBar
            modes={["find", "filter"]}
            mode={searchMode}
            onModeChange={setSearchMode}
            status={searchStatus.text}
            statusTone={searchStatus.tone}
            onQueryChange={(pattern, options) => {
              setSearchPattern(pattern);
              setSearchOptions(options);
            }}
            onNavigate={navigate}
            onClose={closeSearch}
          />
        )}
        {blocks.length > 0 && !running && (
          <div className="flex justify-end border-b border-border/30 px-3 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSaveOpen(true)}
              {...hint("Save this broadcast output to a .otlog session file")}
            >
              Save session…
            </Button>
          </div>
        )}
        <div ref={outputRef} className="min-h-0 flex-1 overflow-y-auto p-4">
          {blocks.length === 0 && pendingHosts.size === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Select hosts, type a command, press Enter.
            </p>
          )}
          <div className="space-y-3">
            {blocks.map((block) => (
              <OutputBlock
                key={block.host_id}
                block={block}
                findData={
                  searchMode === "find" && scan
                    ? {
                        byRef: scan.byRef,
                        activeHit,
                      }
                    : null
                }
                filterMatcher={filterActive ? matcher : null}
                onToggle={() => toggleCollapsed(block.host_id)}
                onReviewMismatch={(stored, presented) => {
                  const host = hostsById.get(block.host_id);
                  if (host) setMismatch({ host, stored, presented });
                }}
              />
            ))}
          </div>
          {pendingHosts.size > 0 && (
            <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
              Waiting on {pendingHosts.size}: {waitingLabels}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border/50 p-3">
          <Composer
            value={command}
            onChange={setCommand}
            onSubmit={send}
            disabled={running}
            history={history}
            placeholder={
              selected.size === 0
                ? "Select at least one host…"
                : `Broadcast to ${selected.size} ${selected.size === 1 ? "host" : "hosts"}…`
            }
          />
          <div className="flex items-center gap-1.5">
            <Input
              value={timeoutSecs}
              onChange={(e) => setTimeoutSecs(e.target.value)}
              disabled={running}
              aria-label="Timeout in seconds"
              className={`h-10 w-16 text-center font-mono text-sm ${parsedTimeout === null ? "border-destructive" : ""}`}
            />
            <span className="text-xs text-muted-foreground">s</span>
          </div>
          <Button
            onClick={send}
            disabled={
              running ||
              !command.trim() ||
              selected.size === 0 ||
              parsedTimeout === null
            }
            aria-label="Send"
            {...hint("Run the command on every selected host")}
          >
            {running ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <SendIcon />
            )}
            Send
          </Button>
        </div>
      </div>
      </div>

      <ConfirmDestructiveDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        command={command.trim()}
        hits={guardHits}
        hostLabels={[...selected]
          .map((id) => hostsById.get(id)?.label ?? `#${id}`)
          .sort()}
        onConfirmed={() => runBroadcast([...selected], command.trim(), true)}
      />

      <BatchTofuDialog
        open={tofuOpen}
        onOpenChange={setTofuOpen}
        entries={tofuEntries}
        onTrusted={retryHosts}
      />

      <KeyMismatchDialog
        open={mismatch !== null}
        onOpenChange={(open) => !open && setMismatch(null)}
        host={mismatch?.host ?? null}
        storedFingerprint={mismatch?.stored ?? null}
        presented={mismatch?.presented ?? null}
        onTrusted={(host) => retryHosts([host.id])}
      />

      <SaveSessionDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        buildLines={buildOtlogLines}
      />
    </div>
  );
}

function statusSummary(result: ExecResult): {
  text: string;
  tone: "ok" | "warn" | "error";
} {
  switch (result.status) {
    case "completed": {
      if (result.timed_out) {
        return {
          text: `[TIMEOUT] ${(result.duration_ms / 1000).toFixed(1)}s`,
          tone: "error",
        };
      }
      const exit = result.exit_code ?? "?";
      return {
        text: `exit ${exit} · ${(result.duration_ms / 1000).toFixed(1)}s`,
        tone: result.exit_code === 0 ? "ok" : "warn",
      };
    }
    case "unknown_key":
      return { text: "unknown host key", tone: "warn" };
    case "key_mismatch":
      return { text: "HOST KEY CHANGED", tone: "error" };
    case "auth_failed":
      return { text: "auth failed", tone: "error" };
    case "unreachable":
      return { text: "unreachable", tone: "error" };
    case "no_credentials":
      return { text: "no credentials", tone: "warn" };
  }
}

type FindData = {
  byRef: Map<string, Map<number, LineMatch[]>>;
  activeHit: FindHit | null;
};

function OutputBlock({
  block,
  findData,
  filterMatcher,
  onToggle,
  onReviewMismatch,
}: {
  block: Block;
  findData: FindData | null;
  filterMatcher: Matcher | null;
  onToggle: () => void;
  onReviewMismatch: (stored: string, presented: PresentedKey) => void;
}) {
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
          {block.label} — 0 matches
        </div>
      );
    }
    return (
      <div className="overflow-hidden rounded-md border border-border/40">
        <BlockHeader
          block={block}
          summaryText={summary.text}
          toneClass={toneClass}
          onToggle={onToggle}
        />
        {!block.collapsed && (
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
    <div className="overflow-hidden rounded-md border border-border/40">
      <BlockHeader
        block={block}
        summaryText={summary.text}
        toneClass={toneClass}
        onToggle={onToggle}
      />
      {!block.collapsed && (
        <div className="px-3 pb-3">
          <BlockBody
            result={result}
            hostId={block.host_id}
            findData={findData}
            onReviewMismatch={onReviewMismatch}
          />
        </div>
      )}
    </div>
  );
}

function filteredLines(
  result: Extract<ExecResult, { status: "completed" }>,
  matcher: Matcher,
): { stream: "stdout" | "stderr"; text: string; matches: LineMatch[] }[] {
  const out: { stream: "stdout" | "stderr"; text: string; matches: LineMatch[] }[] =
    [];
  for (const stream of ["stdout", "stderr"] as const) {
    const text = result[stream];
    if (!text) continue;
    for (const line of text.split("\n")) {
      const matches = matchLine(matcher, line);
      if (matches.length > 0) out.push({ stream, text: line, matches });
    }
  }
  return out;
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

function BlockBody({
  result,
  hostId,
  findData,
  onReviewMismatch,
}: {
  result: ExecResult;
  hostId: number;
  findData: FindData | null;
  onReviewMismatch: (stored: string, presented: PresentedKey) => void;
}) {
  switch (result.status) {
    case "completed":
      return (
        <div className="space-y-2 font-mono text-xs">
          {(["stdout", "stderr"] as const).map((stream) => {
            const text = result[stream];
            if (!text) return null;
            const lineMap = findData?.byRef.get(`${hostId}:${stream}`);
            return (
              <pre
                key={stream}
                className={`whitespace-pre-wrap break-words ${stream === "stderr" ? "text-red-400/90" : ""}`}
              >
                {lineMap ? (
                  <HighlightedText
                    text={text}
                    lineMap={lineMap}
                    activeLine={
                      findData?.activeHit?.hostId === hostId &&
                      findData.activeHit.stream === stream
                        ? findData.activeHit.line
                        : null
                    }
                    activeRange={
                      findData?.activeHit?.hostId === hostId &&
                      findData.activeHit.stream === stream
                        ? {
                            start: findData.activeHit.start,
                            end: findData.activeHit.end,
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
            <p className="text-red-400">[TIMEOUT — partial output above]</p>
          )}
        </div>
      );
    case "unknown_key":
      return (
        <p className="text-xs text-muted-foreground">
          First contact with this endpoint — trust its key in the dialog to
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
      return <p className="text-xs text-red-400/90">{result.message}</p>;
    case "no_credentials":
      return (
        <p className="text-xs text-muted-foreground">
          No credentials stored — edit the host on the Hosts page.
        </p>
      );
  }
}

