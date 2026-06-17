import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  Loader2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Composer } from "@/components/Composer";
import { ConfirmDestructiveDialog } from "@/components/ConfirmDestructiveDialog";
import { ShortcutBar } from "@/components/ShortcutBar";
import { type GuardHit, checkDestructive } from "@/lib/tauri/broadcast";
import { errorMessage, listHosts, type Host } from "@/lib/tauri/hosts";
import { RAIL_SORT_OPTIONS, sortForRail } from "@/lib/railSort";
import {
  ptyHistoryAdd,
  ptyHistoryClear,
  ptyHistoryList,
  ptyWrite,
} from "@/lib/tauri/pty";
import { clearCommandHistory, commandHistory } from "@/lib/tauri/settings";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import type { TermSession } from "@/pages/TerminalsPage";

const HISTORY_RUNS = 200;
/** Persisted collapse state for the session rail (mirrors OmniTerminal). */
const RAIL_COLLAPSED_KEY = "pty-broadcast-rail-collapsed";
/** Persisted "show per-run command header" toggle (mirrors OmniTerminal O4). */
const HEADERS_KEY = "pty-broadcast-headers";

/** Initials of each whitespace-separated word, for the collapsed rail. */
function wordInitials(label: string): string {
  const i = label
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return i || label.slice(0, 2).toUpperCase();
}

type DispatchResult = {
  host_id: number | null;
  label: string;
  color: string;
  ok: boolean;
  message: string | null;
};

/** One dispatch: a command typed into N sessions, with per-session outcomes.
 * Runs append over time and persist across restarts (D-059). */
type RunGroup = {
  runId: string;
  command: string;
  ts: string;
  results: DispatchResult[];
};

/** PTY Broadcast (work-queue 2026-06-12, extended 2026-06-13): mirrors the
 * Broadcast page's host selection, but targets the already-open terminal
 * sessions — the command is typed (with Enter) into every checked PTY. The
 * dispatch report (sent / failed per session) appends and persists; the actual
 * output lives in each terminal tab. */
export function PtyBroadcastPage({
  visible,
  sessions,
  connectedSessions,
  onManageShortcuts,
}: {
  visible: boolean;
  sessions: TermSession[];
  /** Session ids with a live connection — only these can receive input. */
  connectedSessions: Set<string>;
  onManageShortcuts: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  // All dispatch runs, oldest first (newest appended at the bottom).
  const [runs, setRuns] = useState<RunGroup[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [guardHits, setGuardHits] = useState<GuardHit[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Live host lookup so dispatch rows tint by the host's current colour
  // (D-061 sub-4), reloaded when the page is shown.
  const [hostsById, setHostsById] = useState<Map<number, Host>>(new Map());
  const hint = useHint();
  const shortcuts = useShortcuts(visible);
  const outputRef = useRef<HTMLDivElement>(null);

  // Collapsible session rail (mirrors OmniTerminal's O1), persisted.
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
  // Per-run command header toggle (O4): default ON; off = result rows only.
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

  // New sessions arrive pre-selected (mirrors Broadcast's select-all default);
  // sessions the user already unchecked stay unchecked. State persists across
  // tab switches (the page stays mounted) but not restarts.
  const knownIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const s of sessions) {
        if (!knownIds.current.has(s.id) || prev.has(s.id)) next.add(s.id);
      }
      knownIds.current = new Set(sessions.map((s) => s.id));
      return next;
    });
  }, [sessions]);

  // Reload persisted dispatch history + command recall on mount (D-059).
  useEffect(() => {
    ptyHistoryList(HISTORY_RUNS)
      .then((stored) =>
        setRuns(
          stored.map((r) => ({
            runId: r.run_id,
            command: r.command,
            ts: r.ts,
            results: r.results,
          })),
        ),
      )
      .catch(() => {
        // History is best-effort; the page works without it.
      });
    commandHistory(100)
      .then((entries) => setHistory(entries.map((e) => e.command)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [runs]);

  // Refresh the live host colours each time the page is shown.
  useEffect(() => {
    if (!visible) return;
    listHosts()
      .then((hs) => setHostsById(new Map(hs.map((h) => [h.id, h] as const))))
      .catch(() => {});
  }, [visible]);

  usePageStatus(
    sessions.length > 0
      ? `${selected.size}/${sessions.length} sessions selected`
      : null,
    visible,
  );

  const allSelected = sessions.length > 0 && selected.size === sessions.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.id)));
  };
  const toggleSession = (id: string) => {
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

  const dispatch = useCallback(
    async (cmd: string) => {
      setSending(true);
      setHistory((prev) => (prev[0] === cmd ? prev : [cmd, ...prev]));
      const targets = sessions.filter((s) => selected.has(s.id));
      const out: DispatchResult[] = [];
      for (const s of targets) {
        if (!connectedSessions.has(s.id)) {
          out.push({
            host_id: s.host.id,
            label: s.host.label,
            color: s.host.color,
            ok: false,
            message: "session is not connected",
          });
          continue;
        }
        try {
          await ptyWrite(s.id, cmd + "\n");
          out.push({
            host_id: s.host.id,
            label: s.host.label,
            color: s.host.color,
            ok: true,
            message: null,
          });
        } catch (e) {
          out.push({
            host_id: s.host.id,
            label: s.host.label,
            color: s.host.color,
            ok: false,
            message: errorMessage(e),
          });
        }
      }
      const runId = crypto.randomUUID();
      const ts = new Date().toISOString();
      setRuns((prev) => [...prev, { runId, command: cmd, ts, results: out }]);
      // Persist the run (also records the command in shared recall history).
      ptyHistoryAdd({ runId, ts, command: cmd, results: out }).catch(() => {});
      setSending(false);
    },
    [sessions, selected, connectedSessions],
  );

  const send = useCallback(
    async (cmdOverride?: string) => {
      const cmd = (cmdOverride ?? command).trim();
      if (!cmd || selected.size === 0 || sending) return;
      // Same pre-send guard UX as Broadcast (D-014). Note: this path types
      // into interactive PTYs, so the check here is frontend-side courtesy —
      // the backend keystroke channel stays guard-exempt by design.
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
      dispatch(cmd);
      setCommand(""); // clear the composer after sending (P2)
    },
    [command, selected, sending, dispatch],
  );

  const runShortcut = useCallback(
    (cmd: string) => {
      setCommand(cmd);
      send(cmd);
    },
    [send],
  );

  const clearResults = useCallback(async () => {
    try {
      await ptyHistoryClear();
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    setRuns([]);
    toast.success("Dispatch history cleared");
  }, []);

  const clearCmdHistory = useCallback(async () => {
    try {
      await clearCommandHistory();
      setHistory([]);
      toast.success("Command history cleared");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  // Rail sort order (P3). Component stays mounted so this survives tab switches.
  const [railSort, setRailSort] = useState("az");
  const railSessions = useMemo(
    () => sortForRail(sessions, (s) => s.host, railSort),
    [sessions, railSort],
  );

  const hasOutput = runs.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-amber-300/70 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
        Sends the command to every checked terminal session as if typed there.
        Results appear in each tab on the Terminals page.
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Session selection rail (collapsible — mirrors OmniTerminal). */}
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
              aria-label={
                railCollapsed ? "Expand session rail" : "Collapse session rail"
              }
              {...hint(
                railCollapsed
                  ? "Expand the session selection rail"
                  : "Collapse the session selection rail to dots",
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
                {...hint("Select or deselect every open terminal session")}
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={sending || sessions.length === 0}
                />
                Select all
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {selected.size}/{sessions.length}
                </span>
              </label>
            )}
          </div>
          {/* Sort-by dropdown for the session list (P3). */}
          {!railCollapsed && (
            <div className="shrink-0 px-3 pb-2">
              <select
                value={railSort}
                onChange={(e) => setRailSort(e.target.value)}
                aria-label="Sort sessions"
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
          {/* pt-2 (not just pb-2) so the first item's selection ring isn't
              clipped by the scroll container's top edge when collapsed. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {railSessions.map((s) =>
              railCollapsed ? (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSession(s.id)}
                  disabled={sending}
                  title={`${s.host.label}${connectedSessions.has(s.id) ? "" : " (not connected)"}`}
                  className={`mb-1 flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 hover:bg-accent/50 ${
                    selected.has(s.id) ? "bg-accent/40 ring-1 ring-primary/50" : ""
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: s.host.color }}
                  />
                  <span className="font-mono text-[10px] leading-none">
                    {wordInitials(s.host.label)}
                  </span>
                </button>
              ) : (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={selected.has(s.id)}
                    onChange={() => toggleSession(s.id)}
                    disabled={sending}
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: s.host.color }}
                  />
                  <span className="min-w-0 truncate" title={s.host.label}>
                    {s.host.label}
                  </span>
                  <span
                    className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                    connectedSessions.has(s.id)
                      ? "bg-emerald-500"
                      : "bg-red-500/70"
                  }`}
                  title={
                    connectedSessions.has(s.id) ? "Connected" : "Not connected"
                  }
                />
              </label>
              ),
            )}
            {sessions.length === 0 && !railCollapsed && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No open terminal sessions. Open terminals from the Hosts page
                first.
              </p>
            )}
          </div>
          {/* Bottom-pinned clear actions — stay visible while the session list
              above scrolls (work queue 2026-06-13). Hidden when collapsed. */}
          {!railCollapsed && (
            <div className="shrink-0 space-y-1 border-t border-border/50 p-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={clearResults}
                disabled={!hasOutput}
                {...hint("Clear the saved dispatch history (also clears the persisted history)")}
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

        {/* Dispatch report + composer */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 px-3 py-1.5">
            <label
              className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
              {...hint("Show the command + time header above each dispatch. Off = result rows only.")}
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
              disabled={sending || selected.size === 0}
              onRun={runShortcut}
              onManage={onManageShortcuts}
            />
          </div>
          <div ref={outputRef} className="min-h-0 flex-1 overflow-y-auto p-4">
            {!hasOutput ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Select sessions, type a command, press Enter. The command is
                typed into every checked terminal.
              </p>
            ) : (
              <div className="space-y-5">
                {runs.map((run) => (
                  <div key={run.runId} className="space-y-2">
                    {/* Command-sent header, mirroring the Broadcast tab. */}
                    {headers && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="shrink-0 tabular-nums">
                          {formatRunTime(run.ts)}
                        </span>
                        <code className="truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-foreground/80">
                          {run.command}
                        </code>
                      </div>
                    )}
                    <div className="space-y-1">
                      {run.results.map((r, i) => {
                        // Resolve the host's live colour/label by id (D-061
                        // sub-4); fall back to the stored snapshot if the host
                        // is gone or the row predates host_id.
                        const live =
                          r.host_id != null
                            ? hostsById.get(r.host_id)
                            : undefined;
                        const color = live?.color ?? r.color;
                        const label = live?.label ?? r.label;
                        return (
                          <div
                            key={i}
                            className="flex items-center gap-2 rounded-md border border-border/40 px-3 py-1.5 text-sm"
                          >
                            {r.ok ? (
                              <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
                            ) : (
                              <XIcon className="h-4 w-4 shrink-0 text-red-400" />
                            )}
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            <span className="min-w-0 truncate font-medium">
                              {label}
                            </span>
                            <span className="ml-auto font-mono text-xs text-muted-foreground">
                              {r.ok ? "sent — see Terminals tab" : r.message}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-end gap-2 border-t border-border/50 p-3">
            <Composer
              value={command}
              onChange={setCommand}
              onSubmit={send}
              disabled={sessions.length === 0}
              history={history}
              placeholder={
                sessions.length === 0
                  ? "Open terminal sessions first…"
                  : selected.size === 0
                    ? "Select at least one session…"
                    : `Send to ${selected.size} ${selected.size === 1 ? "session" : "sessions"}…`
              }
            />
            <Button
              onClick={() => send()}
              disabled={sending || !command.trim() || selected.size === 0}
              aria-label="Send"
              className="h-10"
              {...hint("Type the command into every checked terminal session")}
            >
              {sending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
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
        hostLabels={sessions
          .filter((s) => selected.has(s.id))
          .map((s) => s.host.label)
          .sort()}
        onConfirmed={() => {
          dispatch(command.trim());
          setCommand("");
        }}
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
