import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SendIcon,
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
import { SearchBar } from "@/components/SearchBar";
import {
  type GuardHit,
  broadcastCommand,
  broadcastHistoryClear,
  broadcastHistoryList,
  checkDestructive,
  onBroadcastResult,
} from "@/lib/tauri/broadcast";
import { type Host, errorMessage, listHosts } from "@/lib/tauri/hosts";
import { RAIL_SORT_OPTIONS } from "@/lib/railSort";
import {
  clearCommandHistory,
  commandHistory,
  getAppSettings,
} from "@/lib/tauri/settings";
import type { PresentedKey } from "@/lib/tauri/ssh";
import { SaveSessionDialog } from "@/components/SaveSessionDialog";
import { ShortcutBar } from "@/components/ShortcutBar";
import type { OtlogLine } from "@/lib/tauri/logs";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import {
  DEFAULT_TIMEOUT_SECS,
  HISTORY_RUNS,
  type RunGroup,
  blockKeyOf,
  otlogLinesFromRuns,
  wordInitials,
} from "@/pages/broadcast/model";
import { OutputBlock } from "@/pages/broadcast/OutputBlock";
import { useBroadcastRail } from "@/pages/broadcast/useBroadcastRail";
import { useOutputSearch } from "@/pages/broadcast/useOutputSearch";
import { useRailFilter } from "@/lib/useRailFilter";
import { RailFilterControls } from "@/components/RailFilterControls";

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
  // Seconds left on the current run's timeout (null when idle) — drives the
  // live countdown shown in place of the timeout field while a run is in flight.
  const [remaining, setRemaining] = useState<number | null>(null);
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

  // Host-selection rail: collapse + headers toggles, sort order, sorted list.
  const {
    railCollapsed,
    toggleRail,
    headers,
    toggleHeaders,
    railSort,
    setRailSort,
    railHosts,
    showRailTag,
  } = useBroadcastRail(hosts, connectedHostIds);

  // Tag + label filter over the rail (view-only; selection is unaffected).
  const railFilter = useRailFilter(hosts, "broadcast-rail-filter");
  const visibleRailHosts = useMemo(
    () => railHosts.filter(railFilter.matches),
    [railHosts, railFilter.matches],
  );

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
  // Inner content wrapper — observed so the view follows output to the true
  // bottom as blocks stream in (the scroll height grows after each result).
  const outputContentRef = useRef<HTMLDivElement>(null);
  // Whether the output is scrolled to (near) the bottom. Starts true so output
  // auto-follows; set false when the user scrolls up to read scrollback, true
  // again when they return to the bottom or dispatch a new command.
  const atBottomRef = useRef(true);
  // Timestamp (ms) until which scroll events are treated as our own auto-scroll
  // and ignored — a programmatic scroll fires a *deferred* scroll event, and if
  // the content grew taller in between, reading scrollTop back would wrongly
  // mark us "not at bottom" and freeze the follow (prompts21: a late timed-out
  // block landed below the fold).
  const autoScrollUntilRef = useRef(0);

  const hostsById = useMemo(() => {
    const map = new Map<number, Host>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);

  // Hosts known from the previous refresh — lets us tell "new host" (gets
  // the selected-by-default treatment) from "existing host the user
  // deselected" (selection preserved) when re-syncing on page return.
  const knownHostIds = useRef<Set<number>>(new Set());
  // Source of truth for the default timeout is Settings -> Performance (Option
  // A). This ref mirrors the last-synced default so the Broadcast field can be
  // a per-run override that snaps back to it after each run, and so a change
  // made in Settings can be told apart from a user override on re-sync.
  const savedTimeoutRef = useRef<number | null>(null);

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

  // Re-sync the default timeout from Settings whenever the page is shown again
  // (Option A). The page stays mounted in the background, so a default changed
  // on the Settings tab would otherwise leave a stale value here (prompts21 C2).
  // Only overwrite the field when it still shows the previously-synced default —
  // a per-run override the user typed but hasn't sent yet is preserved.
  useEffect(() => {
    if (!visible) return;
    getAppSettings()
      .then((s) => {
        const prev = savedTimeoutRef.current;
        savedTimeoutRef.current = s.default_timeout_secs;
        setTimeoutSecs((cur) =>
          prev === null || cur === String(prev)
            ? String(s.default_timeout_secs)
            : cur,
        );
      })
      .catch(() => {
        // Keep the built-in default if settings can't load.
      });
  }, [visible]);

  useEffect(() => {
    commandHistory(100)
      .then((entries) => setHistory(entries.map((e) => e.command)))
      .catch(() => {
        // Recall is a convenience; the composer works without it.
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

  // Find / filter over the accumulated output (D-015): owns search state,
  // scan, navigation and status.
  const {
    searchMode,
    setSearchMode,
    setSearchPattern,
    setSearchOptions,
    matcher,
    scan,
    navigate,
    closeSearch,
    searchStatus,
    activeHit,
    filterActive,
  } = useOutputSearch(runs, visible);

  // Keep the output pinned to the bottom as results stream in. A ResizeObserver
  // on the content catches every height change (each host's block arrives
  // separately and the last one used to land below the fold), so the newest
  // output is always in view — unless the user scrolled up or is searching.
  useEffect(() => {
    const scroller = outputRef.current;
    const content = outputContentRef.current;
    if (!scroller || !content) return;
    const stickToBottom = () => {
      if (searchMode !== null || !atBottomRef.current) return;
      // Suppress the scroll event this assignment queues (fires async, after
      // the content may have grown again) so onOutputScroll doesn't misread it.
      autoScrollUntilRef.current = performance.now() + 150;
      scroller.scrollTop = scroller.scrollHeight;
    };
    const ro = new ResizeObserver(stickToBottom);
    ro.observe(content);
    stickToBottom();
    return () => ro.disconnect();
  }, [runs, searchMode]);

  // Track whether the user is at the bottom so streaming output doesn't yank
  // them down while they're reading earlier results.
  const onOutputScroll = useCallback(() => {
    const el = outputRef.current;
    if (!el) return;
    // Ignore the scroll events our own auto-scroll produces; only a genuine
    // user scroll should be allowed to detach the view from the bottom.
    if (performance.now() < autoScrollUntilRef.current) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

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

  // Tick the countdown down once a second while a run is in flight (C2). The
  // run itself resolves when every host finishes or the timeout elapses, which
  // clears `remaining` — this only drives the visual.
  useEffect(() => {
    if (!running || remaining === null || remaining <= 0) return;
    const t = window.setTimeout(
      () => setRemaining((r) => (r === null ? null : Math.max(0, r - 1))),
      1000,
    );
    return () => window.clearTimeout(t);
  }, [running, remaining]);

  const runBroadcast = useCallback(
    async (hostIds: number[], cmd: string, confirmed: boolean) => {
      const runId = crypto.randomUUID();
      runIdRef.current = runId;
      lastCommandRef.current = cmd;
      lastConfirmedRef.current = confirmed;
      // Mirror the backend's history write (consecutive duplicates collapse).
      setHistory((prev) => (prev[0] === cmd ? prev : [cmd, ...prev]));
      setRunning(true);
      // Kick off the visible countdown from the timeout this run will use.
      setRemaining(parsedTimeout ?? DEFAULT_TIMEOUT_SECS);
      // A fresh dispatch always follows its own output to the bottom, even if
      // the user had scrolled up in the previous run's results.
      atBottomRef.current = true;
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
        setRemaining(null);
        // Option A: the field is a per-run override — snap it back to the
        // Settings default once the run finishes (or times out).
        setTimeoutSecs(String(savedTimeoutRef.current ?? DEFAULT_TIMEOUT_SECS));
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

  /** Re-run a single host from a specific run's failed block (the per-block
   * Retry button). Uses that run's own command so retrying an older run is
   * correct, and passes confirmed=true — the command already cleared the guard
   * when it was first dispatched. Lands as a fresh one-host run. */
  const retryHostInRun = useCallback(
    (command: string, hostId: number) => {
      runBroadcast([hostId], command, true);
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

  const buildOtlogLines = useCallback(
    (): OtlogLine[] => otlogLinesFromRuns(runs),
    [runs],
  );

  const hasOutput = runs.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Static reminder of the exec-channel contract (D-002). */}
      <div className="shrink-0 border-b border-amber-300/70 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
        Use Broadcast for commands that run and finish on their own. Use the
        terminal for more complex interaction.
      </div>
      <div className="flex min-h-0 flex-1">
      {/* Host selection rail (collapsible — mirrors MultiTerminal). */}
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
        {/* Tag + label filter (mirrors the Hosts table's tag filter). */}
        {!railCollapsed && <RailFilterControls f={railFilter} />}
        {/* pt-2 (not just pb-2) so the first item's selection ring isn't
            clipped by the scroll container's top edge when collapsed. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {visibleRailHosts.map((h) =>
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
                {showRailTag && (
                  <span
                    className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                    title={h.tag ? `Tag: ${h.tag}` : "No tag"}
                  >
                    {h.tag ?? "—"}
                  </span>
                )}
                {/* Live terminal-connection dot (user request): green when this
                    host has a connected terminal, red otherwise. */}
                <span
                  className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                    connectedHostIds.has(h.id) ? "bg-emerald-500" : "bg-red-500/60"
                  }`}
                  title={
                    connectedHostIds.has(h.id)
                      ? "Connected: a terminal to this host is open"
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
          {hosts.length > 0 &&
            visibleRailHosts.length === 0 &&
            !railCollapsed &&
            railFilter.filterActive && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No hosts match the current filter.
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
            activeScope="ssh"
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
        <div
          ref={outputRef}
          onScroll={onOutputScroll}
          className="min-h-0 flex-1 overflow-y-auto p-4"
        >
          {!hasOutput && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Select hosts, type a command, press Enter.
            </p>
          )}
          <div ref={outputContentRef} className="space-y-5">
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
                        onRetry={
                          running
                            ? undefined
                            : () => retryHostInRun(run.command, block.host_id)
                        }
                      />
                    );
                  })}
                </div>
                {run.pending.size > 0 && (
                  <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                    <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
                    Waiting on {run.pending.size}: {waitingLabels}
                    {running && remaining !== null && (
                      <span className="tabular-nums text-muted-foreground/80">
                        · {remaining}s left
                      </span>
                    )}
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
              value={
                running && remaining !== null ? String(remaining) : timeoutSecs
              }
              onChange={(e) => setTimeoutSecs(e.target.value)}
              disabled={running}
              aria-label={running ? "Timeout countdown (seconds)" : "Timeout in seconds"}
              className={`h-10 w-16 text-center font-mono text-sm ${
                running
                  ? remaining !== null && remaining <= 3
                    ? "text-red-400"
                    : "text-amber-400"
                  : parsedTimeout === null
                    ? "border-destructive"
                    : ""
              }`}
              {...hint(
                running
                  ? "Time left before this run times out."
                  : "Per-command timeout in seconds (1-3600). Overrides this run only; resets to the Settings → Performance default afterward. Partial output is kept if it elapses.",
              )}
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
