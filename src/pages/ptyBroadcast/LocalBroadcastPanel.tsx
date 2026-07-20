import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  Loader2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SendIcon,
  XIcon,
} from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/Composer";
import { ScrollToBottom } from "@/components/ScrollToBottom";
import { ShortcutBar } from "@/components/ShortcutBar";
import type { ShortcutScope } from "@/lib/tauri/settings";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import { LocalShellIcon, type LocalTermSession } from "@/pages/TerminalsPage";
import { useSessionBroadcast } from "@/pages/ptyBroadcast/useSessionBroadcast";

/** Neutral dot colour for local shells (they have no per-host colour). Matches
 * the placeholder colour App uses for a maximized local shell. */
const LOCAL_COLOR = "#6b7280";

/**
 * PTY Broadcast — one local-shell family tab (PowerShell / Command Prompt / WSL).
 * Fans a command out to every checked open shell of that family on THIS machine.
 * Unlike the SSH panel this is shell-oriented (icon + label, no host colours,
 * tags, or persisted history) and is deliberately guarded: a persistent yellow
 * danger banner, and a confirm dialog before every send. Local shells over
 * ConPTY need `\r` to execute (a bare `\n` parks PowerShell/cmd at a `>>`
 * continuation prompt), so the hook is driven with `lineEnding: "\r"`.
 */
export function LocalBroadcastPanel({
  visible,
  family,
  sessions,
  connectedSessions,
  scope,
  onManageShortcuts,
  storagePrefix,
}: {
  visible: boolean;
  /** Human name of the shell family, e.g. "PowerShell" — used in copy. */
  family: string;
  sessions: LocalTermSession[];
  connectedSessions: Set<string>;
  /** Shortcut scope for this family (Windows shells → local; WSL → ssh). */
  scope: ShortcutScope;
  onManageShortcuts: () => void;
  /** Distinct localStorage key prefix so each family's rail state is separate. */
  storagePrefix: string;
}) {
  const railKey = `${storagePrefix}-rail-collapsed`;

  // Duplicate " 02" suffix per shell id, ordered by creation seq (mirrors
  // TerminalsPage's tab suffix): the 2nd+ copy of the same shell gets a number
  // so otherwise-identical labels ("PowerShell") stay distinguishable.
  const suffixById = useMemo(() => {
    const counts = new Map<string, number>();
    const map = new Map<string, string>();
    for (const s of [...sessions].sort((a, b) => a.seq - b.seq)) {
      const n = (counts.get(s.shell.id) ?? 0) + 1;
      counts.set(s.shell.id, n);
      map.set(s.id, n > 1 ? ` ${String(n).padStart(2, "0")}` : "");
    }
    return map;
  }, [sessions]);

  const labelFor = useCallback(
    (s: LocalTermSession) => s.shell.label + (suffixById.get(s.id) ?? ""),
    [suffixById],
  );

  const describe = useCallback(
    (s: LocalTermSession) => ({
      host_id: null,
      label: labelFor(s),
      color: LOCAL_COLOR,
      kind: s.shell.kind,
    }),
    [labelFor],
  );

  const {
    selected,
    setSelected,
    toggleSession,
    command,
    setCommand,
    sending,
    runs,
    history,
    dispatch,
    clearResults,
  } = useSessionBroadcast({
    sessions,
    connectedSessions,
    lineEnding: "\r",
    persist: false,
    describe,
  });

  const hint = useHint();
  const shortcuts = useShortcuts(visible);
  const outputRef = useRef<HTMLDivElement>(null);

  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(railKey) === "1",
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(railKey, next ? "1" : "0");
      return next;
    });
  }, [railKey]);

  // The command awaiting the "run on N shells?" confirmation. Every local send
  // is gated by this dialog — the fan-out runs immediately with no undo, so the
  // operator confirms each time (this is the safety story for local shells).
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [runs]);

  usePageStatus(
    sessions.length > 0
      ? `${selected.size}/${sessions.length} ${family} shells selected`
      : null,
    visible,
  );

  const allSelected =
    sessions.length > 0 && sessions.every((s) => selected.has(s.id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(sessions.map((s) => s.id)));
  };

  // Ask before sending — never dispatch straight from the composer.
  const requestSend = useCallback(
    (cmdOverride?: string) => {
      const cmd = (cmdOverride ?? command).trim();
      if (!cmd || selected.size === 0 || sending) return;
      setPending(cmd);
    },
    [command, selected, sending],
  );

  const confirmSend = useCallback(() => {
    if (pending == null) return;
    dispatch(pending);
    setCommand("");
    setPending(null);
  }, [pending, dispatch, setCommand]);

  const runShortcut = useCallback(
    (cmd: string) => {
      setCommand(cmd);
      requestSend(cmd);
    },
    [requestSend, setCommand],
  );

  const hasOutput = runs.length > 0;
  const targetLabels = useMemo(
    () =>
      sessions
        .filter((s) => selected.has(s.id))
        .map((s) => labelFor(s))
        .sort(),
    [sessions, selected, labelFor],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Persistent danger banner — this types into real local shells. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-yellow-400/70 bg-yellow-50 px-4 py-1.5 text-xs text-yellow-800 dark:border-yellow-500/30 dark:bg-yellow-500/10 dark:text-yellow-300/90">
        <AlertTriangleIcon className="h-3.5 w-3.5 shrink-0" />
        <span>
          Runs the command in every checked {family} shell on this machine,
          immediately and with no undo. Each send asks for confirmation.
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Shell selection rail (collapsible). */}
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
                railCollapsed ? "Expand shell rail" : "Collapse shell rail"
              }
              {...hint(
                railCollapsed
                  ? "Expand the shell selection rail"
                  : "Collapse the shell selection rail to icons",
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
                {...hint(`Select or deselect every open ${family} shell`)}
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
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {sessions.map((s) =>
              railCollapsed ? (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleSession(s.id)}
                  disabled={sending}
                  title={labelFor(s)}
                  className={`mb-1 flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 hover:bg-accent/50 ${
                    selected.has(s.id) ? "bg-accent/40 ring-1 ring-primary/50" : ""
                  }`}
                >
                  <LocalShellIcon
                    kind={s.shell.kind}
                    className="h-4 w-4 text-muted-foreground"
                  />
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
                  <LocalShellIcon
                    kind={s.shell.kind}
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 truncate" title={labelFor(s)}>
                    {labelFor(s)}
                  </span>
                </label>
              ),
            )}
            {sessions.length === 0 && !railCollapsed && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No open {family} shells. Open one from the Terminals page (the
                “+” launcher) first.
              </p>
            )}
          </div>
          {!railCollapsed && (
            <div className="shrink-0 space-y-1 border-t border-border/50 p-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={clearResults}
                disabled={!hasOutput}
                {...hint("Clear this session's dispatch report")}
              >
                Clear results
              </Button>
            </div>
          )}
        </div>

        {/* Dispatch report + composer */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border/30 px-3 py-1.5">
            <ShortcutBar
              shortcuts={shortcuts}
              activeScope={scope}
              disabled={sending || selected.size === 0}
              onRun={runShortcut}
              onManage={onManageShortcuts}
            />
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={outputRef} className="min-h-0 flex-1 overflow-y-auto p-4">
              {!hasOutput ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Select shells, type a command, press Enter. You confirm, then
                  the command runs in every checked {family} shell.
                </p>
              ) : (
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
                      <div className="space-y-1">
                        {run.results.map((r, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-2 rounded-md border border-border/40 px-3 py-1.5 text-sm"
                          >
                            {r.ok ? (
                              <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
                            ) : (
                              <XIcon className="h-4 w-4 shrink-0 text-red-400" />
                            )}
                            <LocalShellIcon
                              kind={r.kind ?? ""}
                              className="h-4 w-4 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0 truncate font-medium">
                              {r.label}
                            </span>
                            <span className="ml-auto font-mono text-xs text-muted-foreground">
                              {r.ok ? "sent (see Terminals tab)" : r.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <ScrollToBottom scrollerRef={outputRef} />
          </div>

          <div className="flex items-end gap-2 border-t border-border/50 p-3">
            <Composer
              value={command}
              onChange={setCommand}
              onSubmit={requestSend}
              disabled={sessions.length === 0}
              history={history}
              placeholder={
                sessions.length === 0
                  ? `Open a ${family} shell first…`
                  : selected.size === 0
                    ? "Select at least one shell…"
                    : `Send to ${selected.size} ${selected.size === 1 ? "shell" : "shells"}…`
              }
            />
            <Button
              onClick={() => requestSend()}
              disabled={sending || !command.trim() || selected.size === 0}
              aria-label="Send"
              className="h-10"
              {...hint(`Run the command in every checked ${family} shell (asks to confirm)`)}
            >
              {sending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
              Send
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog
        open={pending != null}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Run on {targetLabels.length}{" "}
              {targetLabels.length === 1 ? "shell" : "shells"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This types the command into every selected {family} shell on this
              machine and runs it immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-sm">
            <code className="block truncate rounded bg-muted/60 px-2 py-1 font-mono text-foreground/90">
              {pending}
            </code>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
              {targetLabels.map((label) => (
                <li key={label} className="truncate">
                  {label}
                </li>
              ))}
            </ul>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSend}>
              Run command
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Run-header timestamp as `YYYY-MM-DD HH:MM:SS UTC`. */
function formatRunTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
}
