import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
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
  broadcastHistoryClear,
  broadcastHistoryList,
  checkDestructive,
  onBroadcastResult,
} from "@/lib/tauri/broadcast";
import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
import { RAIL_SORT_OPTIONS, sortForRail } from "@/lib/railSort";
import {
  clearCommandHistory,
  commandHistory,
  getAppSettings,
} from "@/lib/tauri/settings";
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
import { ShortcutBar } from "@/components/ShortcutBar";
import type { OtlogLine } from "@/lib/tauri/logs";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";

const DEFAULT_TIMEOUT_SECS = 30;
/** How many past runs to reload on mount (matches the backend cap). */
const HISTORY_RUNS = 200;
/** Persisted collapse state for the host selection rail (mirrors OmniTerminal). */
const RAIL_COLLAPSED_KEY = "broadcast-rail-collapsed";
/** Persisted "show per-host output headers" toggle (mirrors OmniTerminal O4). */
const HEADERS_KEY = "broadcast-headers";

/** Initials of each whitespace-separated word, for the collapsed rail. */
function wordInitials(label: string): string {
  const i = label
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return i || label.slice(0, 2).toUpperCase();
}

type Block = HostExecReport & { collapsed: boolean; receivedAt: string };

/** One broadcast run: a command sent to N hosts, plus the per-host result
 * blocks (completion order) and the set still pending. Runs append over time
 * and persist across restarts (D-059). */
type RunGroup = {
  runId: string;
  command: string;
  ts: string;
  blocks: Block[];
  pending: Set<number>;
};

/** Stable per-block key — a host can appear in many runs, so host_id alone is
 * not unique across the appended history. */
const blockKeyOf = (runId: string, hostId: number) => `${runId}:${hostId}`;

/** One navigable find hit (a single match occurrence). */
type FindHit = {
  key: string;
  stream: "stdout" | "stderr";
  line: number;
  start: number;
  end: number;
};

export function BroadcastPage({
  visible,
  connectedHostIds,
  onManageShortcuts,
}: {
  visible: boolean;
  /** Host ids with at least one connected terminal — drives the status dot. */
  connectedHostIds: Set<number>;
  onManageShortcuts: () => void;
}) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [command, setCommand] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(String(DEFAULT_TIMEOUT_SECS));
  const [running, setRunning] = useState(false);
  // All runs, oldest first (newest appended at the bottom).
  const [runs, setRuns] = useState<RunGroup[]>([]);
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

  // Collapsible host rail (mirrors OmniTerminal's O1), persisted.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }, []);
  // Per-host output headers toggle (O4): default ON; off = output only.
  const [headers, setHeaders] = useState(
    () => localStorage.getItem(HEADERS_KEY) !== "0",
  );
  const toggleHeaders = useCallback(() => {
    setHeaders((prev) => {
      const next = !prev;
      localStorage.setItem(HEADERS_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const hint = useHint();
  const shortcuts = useShortcuts(visible);

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
    // Reload persisted result history so output survives restarts (D-059).
    broadcastHistoryList(HISTORY_RUNS)
      .then((stored) =>
        setRuns(
          stored.map((r) => ({
            runId: r.run_id,
            command: r.command,
            ts: r.ts,
            pending: new Set<number>(),
            blocks: r.results.map((res) => ({
              run_id: r.run_id,
              host_id: res.host_id,
              label: res.label,
              color: res.color,
              result: res.result,
              // Reloaded history starts collapsed so the page isn't a wall.
              collapsed: true,
              receivedAt: r.ts,
            })),
          })),
        ),
      )
      .catch(() => {
        // History is best-effort; the page works without it.
      });
  }, []);

  useEffect(() => {
    const unlisten = onBroadcastResult((report) => {
      setRuns((prev) =>
        prev.map((r) => {
          if (r.runId !== report.run_id) return r;
          const pending = new Set(r.pending);
          pending.delete(report.host_id);
          // A retry replaces the host's previous block within this run.
          const blocks = [
            ...r.blocks.filter((b) => b.host_id !== report.host_id),
            {
              ...report,
              collapsed: false,
              receivedAt: new Date().toISOString(),
            },
          ];
          return { ...r, pending, blocks };
        }),
      );
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
  }, [runs, searchMode]);

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

  /** Per-stream line matches for every completed block across all runs, in
   * display order. Keyed by `${runId}:${hostId}:${stream}`. */
  const scan = useMemo(() => {
    if (!matcher) return null;
    const byRef = new Map<string, Map<number, LineMatch[]>>();
    const hits: FindHit[] = [];
    const blocksWithMatches = new Set<string>();
    let total = 0;
    for (const run of runs) {
      for (const block of run.blocks) {
        if (block.result.status !== "completed") continue;
        const key = blockKeyOf(run.runId, block.host_id);
        for (const stream of ["stdout", "stderr"] as const) {
          const text = block.result[stream];
          if (!text) continue;
          const lines = text.split("\n");
          const lineMap = new Map<number, LineMatch[]>();
          for (let i = 0; i < lines.length; i++) {
            const matches = matchLine(matcher, lines[i]);
            if (matches.length > 0) {
              lineMap.set(i, matches);
              blocksWithMatches.add(key);
              total += matches.length;
              for (const m of matches) {
                hits.push({ key, stream, line: i, ...m });
              }
            }
          }
          if (lineMap.size > 0) {
            byRef.set(`${key}:${stream}`, lineMap);
          }
        }
      }
    }
    return { byRef, hits, total, hostCount: blocksWithMatches.size };
  }, [matcher, runs]);

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
    const base = `${scan.total} ${scan.total === 1 ? "match" : "matches"} in ${scan.hostCount} ${scan.hostCount === 1 ? "block" : "blocks"}`;
    return {
      text:
        searchMode === "find"
          ? `${scan.hits.length === 0 ? 0 : activeHitIdx + 1}/${scan.hits.length} · ${base}`
          : base,
      tone: "normal" as const,
    };
  })();

  // Rail sort order (B3). Component stays mounted so this survives tab switches.
  const [railSort, setRailSort] = useState("az");
  const railHosts = useMemo(
    () => sortForRail(hosts, (h) => h, railSort),
    [hosts, railSort],
  );

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
      // Append a new run; previous runs stay (appending history, D-059).
      setRuns((prev) => [
        ...prev,
        {
          runId,
          command: cmd,
          ts: new Date().toISOString(),
          blocks: [],
          pending: new Set(hostIds),
        },
      ]);
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
        setRuns((prev) =>
          prev.map((r) =>
            r.runId === runId ? { ...r, pending: new Set() } : r,
          ),
        );
      } finally {
        setRunning(false);
      }
    },
    [hostsById, parsedTimeout],
  );

  const send = useCallback(
    async (cmdOverride?: string) => {
      const cmd = (cmdOverride ?? command).trim();
      if (!cmd || selected.size === 0 || running || parsedTimeout === null) {
        return;
      }
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
      setCommand(""); // clear the composer after sending (B2)
    },
    [command, selected, running, parsedTimeout, runBroadcast],
  );

  /** Shortcut Go: show the command in the composer and send it through the
   * normal path — guard check included. */
  const runShortcut = useCallback(
    (cmd: string) => {
      setCommand(cmd);
      send(cmd);
    },
    [send],
  );

  const retryHosts = useCallback(
    (hostIds: number[]) => {
      runBroadcast(hostIds, lastCommandRef.current, lastConfirmedRef.current);
    },
    [runBroadcast],
  );

  const toggleCollapsed = (runId: string, hostId: number) => {
    setRuns((prev) =>
      prev.map((r) =>
        r.runId !== runId
          ? r
          : {
              ...r,
              blocks: r.blocks.map((b) =>
                b.host_id === hostId ? { ...b, collapsed: !b.collapsed } : b,
              ),
            },
      ),
    );
  };

  /** Clears the persistent result history (this session and on disk). */
  const clearResults = useCallback(async () => {
    try {
      await broadcastHistoryClear();
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    setRuns([]);
    toast.success("Broadcast results cleared");
  }, []);

  /** Clears the Up/Down command recall history. */
  const clearCmdHistory = useCallback(async () => {
    try {
      await clearCommandHistory();
      setHistory([]);
      toast.success("Command history cleared");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  const activeRun = runs.find((r) => r.pending.size > 0);
  const waitingLabels = activeRun
    ? [...activeRun.pending]
        .map((id) => hostsById.get(id)?.label ?? `#${id}`)
        .join(", ")
    : "";

  /** Current output as .otlog lines (D-010): per output line, plus a status
   * line per host so failures are part of the record. */
  const buildOtlogLines = useCallback((): OtlogLine[] => {
    const out: OtlogLine[] = [];
    for (const run of runs) {
      for (const block of run.blocks) {
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
    }
    return out;
  }, [runs]);

  const activeHit =
    searchMode === "find" && scan && scan.hits.length > 0
      ? scan.hits[Math.min(activeHitIdx, scan.hits.length - 1)]
      : null;

  const filterActive = searchMode === "filter" && matcher !== null && searchPattern !== "";
  const hasOutput = runs.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Static reminder of the exec-channel contract (D-002). */}
      <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300/90">
        The broadcast channel is exclusively for non-interactive commands that
        print output and exit.
      </div>
      <div className="flex min-h-0 flex-1">
      {/* Host selection rail (collapsible — mirrors OmniTerminal). */}
      <div
        className={`flex shrink-0 flex-col border-r border-border/50 ${
          railCollapsed ? "w-14" : "w-60"
        }`}
      >
        <div className="flex shrink-0 items-center gap-2 px-2 py-2">
          <button
            type="button"
            onClick={toggleRail}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            aria-label={railCollapsed ? "Expand host rail" : "Collapse host rail"}
            {...hint(
              railCollapsed
                ? "Expand the host selection rail"
                : "Collapse the host selection rail to dots",
            )}
          >
            {railCollapsed ? (
              <PanelLeftOpenIcon className="h-4 w-4" />
            ) : (
              <PanelLeftCloseIcon className="h-4 w-4" />
            )}
          </button>
          {!railCollapsed && (
            <label
              className="flex cursor-pointer items-center gap-2 text-sm font-medium"
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
          )}
        </div>
        {/* Sort-by dropdown for the host list (B3). */}
        {!railCollapsed && (
          <div className="shrink-0 px-3 pb-2">
            <select
              value={railSort}
              onChange={(e) => setRailSort(e.target.value)}
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
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {railHosts.map((h) =>
            railCollapsed ? (
              <button
                key={h.id}
                type="button"
                onClick={() => toggleHost(h.id)}
                disabled={running}
                title={`${h.label}${connectedHostIds.has(h.id) ? "" : " (no connected terminal)"}`}
                className={`mb-1 flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 hover:bg-accent/50 ${
                  selected.has(h.id) ? "bg-accent/40 ring-1 ring-primary/50" : ""
                }`}
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
                  checked={selected.has(h.id)}
                  onChange={() => toggleHost(h.id)}
                  disabled={running}
                />
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: h.color }}
                />
                <span className="min-w-0 truncate" title={h.label}>
                  {h.label}
                </span>
                {/* Live terminal-connection dot (user request): green when this
                    host has a connected terminal, red otherwise. */}
                <span
                  className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                    connectedHostIds.has(h.id) ? "bg-emerald-500" : "bg-red-500/60"
                  }`}
                  title={
                    connectedHostIds.has(h.id)
                      ? "Connected — a terminal to this host is open"
                      : "No connected terminal for this host"
                  }
                />
              </label>
            ),
          )}
          {hosts.length === 0 && !railCollapsed && (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No hosts configured. Add hosts on the Hosts page first.
            </p>
          )}
        </div>
        {/* Bottom-pinned clear actions — stay visible while the host list
            above scrolls (work queue 2026-06-13). Hidden when collapsed. */}
        {!railCollapsed && (
          <div className="shrink-0 space-y-1 border-t border-border/50 p-2">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={clearResults}
              disabled={!hasOutput}
              {...hint("Clear all saved broadcast results (also clears the persisted history)")}
            >
              Clear results
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={clearCmdHistory}
              {...hint("Clear the Up/Down command recall history")}
            >
              Clear command history
            </Button>
          </div>
        )}
      </div>

      {/* Output + composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 px-3 py-1.5">
          <label
            className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
            {...hint("Show the per-host header (label, exit, time) above each result. Off = output only.")}
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={headers}
              onChange={toggleHeaders}
            />
            Headers
          </label>
          <ShortcutBar
            shortcuts={shortcuts}
            disabled={running || selected.size === 0}
            onRun={runShortcut}
            onManage={onManageShortcuts}
          />
        </div>
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
        {hasOutput && !running && (
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
          {!hasOutput && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Select hosts, type a command, press Enter.
            </p>
          )}
          <div className="space-y-5">
            {runs.map((run) => (
              <div key={run.runId} className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="shrink-0 tabular-nums">
                    {formatRunTime(run.ts)}
                  </span>
                  <code className="truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-foreground/80">
                    {run.command}
                  </code>
                </div>
                <div className="space-y-3">
                  {run.blocks.map((block) => {
                    const key = blockKeyOf(run.runId, block.host_id);
                    // Tint by the host's live colour/label (D-061 sub-4); fall
                    // back to the stored snapshot if the host is gone.
                    const live = hostsById.get(block.host_id);
                    const tinted = live
                      ? { ...block, color: live.color, label: live.label }
                      : block;
                    return (
                      <OutputBlock
                        key={key}
                        block={tinted}
                        blockKey={key}
                        showHeader={headers}
                        findData={
                          searchMode === "find" && scan
                            ? { byRef: scan.byRef, activeHit }
                            : null
                        }
                        filterMatcher={filterActive ? matcher : null}
                        onToggle={() => toggleCollapsed(run.runId, block.host_id)}
                        onReviewMismatch={(stored, presented) => {
                          const host = hostsById.get(block.host_id);
                          if (host) setMismatch({ host, stored, presented });
                        }}
                      />
                    );
                  })}
                </div>
                {run.pending.size > 0 && (
                  <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                    <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                    Waiting on {run.pending.size}: {waitingLabels}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-end gap-2 border-t border-border/50 p-3">
          <Composer
            value={command}
            onChange={setCommand}
            onSubmit={send}
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
              {...hint("Per-command timeout in seconds (1–3600). Partial output is kept if it elapses.")}
            />
            <span className="text-xs text-muted-foreground">s</span>
          </div>
          <Button
            onClick={() => send()}
            disabled={
              running ||
              !command.trim() ||
              selected.size === 0 ||
              parsedTimeout === null
            }
            aria-label="Send"
            className="h-10"
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
        onConfirmed={() => {
          runBroadcast([...selected], command.trim(), true);
          setCommand("");
        }}
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

/** Run-header timestamp as `YYYY-MM-DD HH:MM:SS UTC` (B4). */
function formatRunTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
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
  blockKey,
  showHeader,
  findData,
  filterMatcher,
  onToggle,
  onReviewMismatch,
}: {
  block: Block;
  blockKey: string;
  /** When false, hide the per-host header (output only, color-tinted). */
  showHeader: boolean;
  findData: FindData | null;
  filterMatcher: Matcher | null;
  onToggle: () => void;
  onReviewMismatch: (stored: string, presented: PresentedKey) => void;
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
          {block.label} — 0 matches
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
  blockKey,
  findData,
  onReviewMismatch,
}: {
  result: ExecResult;
  blockKey: string;
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
