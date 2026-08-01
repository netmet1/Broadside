import { useCallback, useMemo, useState } from "react";
import { AlertTriangleIcon, EraserIcon, SendIcon } from "lucide-react";
import { toast } from "sonner";

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
import { checkDestructive, type GuardHit } from "@/lib/tauri/broadcast";
import { errorMessage } from "@/lib/tauri/hosts";
import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";
import { sessionLabel, type TermSession } from "@/pages/terminals/session";
import { useSessionBroadcast } from "@/pages/ptyBroadcast/useSessionBroadcast";

/** Neutral dot colour for local shells (they have no per-host colour). */
const LOCAL_COLOR = "#6b7280";

/** The broadcast families, in the order the rail lists them. This mirrors the
 * PTY Broadcast page's four tabs deliberately: a command has to be valid for
 * everything it reaches, so a broadcast is always within one family. Custom
 * POSIX terminals ride with WSL, as they do there. */
type Family = "ssh" | "powershell" | "cmd" | "posix";

const FAMILY_LABELS: Record<Family, string> = {
  ssh: "SSH hosts",
  powershell: "PowerShell",
  cmd: "Command Prompt",
  posix: "WSL / POSIX",
};

function familyOf(s: TermSession): Family | null {
  if (s.type === "ssh") return "ssh";
  const k = s.shell.kind;
  if (k === "powershell" || k === "pwsh") return "powershell";
  if (k === "cmd") return "cmd";
  if (k === "wsl" || k === "posix") return "posix";
  return null;
}

/**
 * Broadcast from inside the Terminals page: pick targets on the left, type once
 * at the bottom, and watch every pane react where you already are.
 *
 * This exists because the standalone PTY Broadcast page dispatches and then
 * tells you to go and look somewhere else ("Results appear in each tab on the
 * Terminals page"), which meant issuing a command and immediately switching
 * tabs to see how it went. Paired with Grid, that round trip disappears.
 *
 * It does NOT replace that page, which keeps the persisted dispatch history and
 * the full per-run report. This is the live, in-place composer; that is the
 * record. Both drive the same `useSessionBroadcast` hook, and both keep the
 * same safety behaviour: the destructive-command guard for SSH targets, and a
 * confirmation before every local-shell send.
 */
export function BroadcastRail({
  sessions,
  connectedSessions,
}: {
  sessions: TermSession[];
  connectedSessions: Set<string>;
}) {
  const hint = useHint();

  // One family at a time, like the PTY Broadcast tabs. Mixing them is a real
  // foot-gun: the command wouldn't be valid everywhere, and the line ending
  // differs (SSH needs \n; local shells need \r or PowerShell and cmd park at a
  // ">>" continuation prompt instead of running anything).
  const [family, setFamily] = useState<Family>("ssh");

  const byFamily = useMemo(() => {
    const m: Record<Family, TermSession[]> = {
      ssh: [],
      powershell: [],
      cmd: [],
      posix: [],
    };
    for (const s of sessions) {
      const f = familyOf(s);
      if (f) m[f].push(s);
    }
    return m;
  }, [sessions]);

  const targets = byFamily[family];
  const isSsh = family === "ssh";

  const describe = useCallback(
    (s: TermSession) => ({
      host_id: s.type === "ssh" ? s.host.id : null,
      label: sessionLabel(s),
      color: s.type === "ssh" ? s.host.color : LOCAL_COLOR,
      kind: s.type === "local" ? s.shell.kind : undefined,
    }),
    [],
  );

  const {
    selected,
    setSelected,
    toggleSession,
    command,
    setCommand,
    sending,
    history,
    dispatch,
    clearCmdHistory,
  } = useSessionBroadcast({
    sessions: targets,
    connectedSessions,
    lineEnding: isSsh ? "\n" : "\r",
    // The standalone page owns the persisted run reports; this is the live
    // view, so it never writes a second copy of the same run.
    persist: false,
    // The recall list is a different matter: there is only one of those, and
    // typing the same command in a different place should not mean losing the
    // last one you typed. Up/Down here is the PTY Broadcast page's history.
    sharedRecall: true,
    describe,
  });

  // A destructive command awaiting confirmation (SSH), or any local send (local
  // shells confirm every time, as the standalone panel does).
  const [pending, setPending] = useState<string | null>(null);
  const [guardHits, setGuardHits] = useState<GuardHit[]>([]);

  // Only a connected session can be a target, so it is the connected ones that
  // "Select all" covers and the ones "all" is measured against. A rail full of
  // dropped sessions leaves the box unchecked and does nothing, which is the
  // truth of what would be sent.
  const connectedTargets = useMemo(
    () => targets.filter((s) => connectedSessions.has(s.id)),
    [targets, connectedSessions],
  );
  const allSelected =
    connectedTargets.length > 0 &&
    connectedTargets.every((s) => selected.has(s.id));

  const send = useCallback(async () => {
    const cmd = command.trim();
    if (!cmd || selected.size === 0 || sending) return;
    if (isSsh) {
      // Same pre-send guard as everywhere else a command is fanned out (D-014).
      try {
        const hits = await checkDestructive(cmd);
        if (hits.length > 0) {
          setGuardHits(hits);
          setPending(cmd);
          return;
        }
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
      dispatch(cmd);
      setCommand("");
      return;
    }
    // Local shells: the fan-out runs immediately with no undo, so every send is
    // confirmed. Never dispatch straight from the composer.
    setGuardHits([]);
    setPending(cmd);
  }, [command, selected, sending, isSsh, dispatch, setCommand]);

  const confirmSend = useCallback(() => {
    if (pending === null) return;
    dispatch(pending);
    setCommand("");
    setPending(null);
    setGuardHits([]);
  }, [pending, dispatch, setCommand]);

  const selectedCount = selected.size;

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border/50 bg-background">
      <div className="shrink-0 border-b border-border/50 px-2 py-1.5">
        <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Broadcast to
        </label>
        <select
          value={family}
          onChange={(e) => setFamily(e.target.value as Family)}
          className="mt-1 w-full rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
          aria-label="Broadcast family"
          {...hint(
            "One shell language at a time, so a command is always valid for everything it goes to.",
          )}
        >
          {(Object.keys(FAMILY_LABELS) as Family[]).map((f) => (
            <option key={f} value={f}>
              {FAMILY_LABELS[f]} ({byFamily[f].length})
            </option>
          ))}
        </select>
      </div>

      {targets.length > 1 && (
        <label className="flex shrink-0 cursor-pointer items-center gap-2 border-b border-border/50 px-2 py-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-primary"
            checked={allSelected}
            disabled={connectedTargets.length === 0}
            onChange={() =>
              setSelected(
                allSelected
                  ? new Set()
                  : new Set(connectedTargets.map((s) => s.id)),
              )
            }
          />
          Select all
        </label>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {targets.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No open {FAMILY_LABELS[family]} sessions.
          </p>
        ) : (
          targets.map((s) => {
            const connected = connectedSessions.has(s.id);
            return (
              <label
                key={s.id}
                title={
                  connected
                    ? undefined
                    : "Disconnected: reconnect the terminal to broadcast to it"
                }
                className={cn(
                  "flex items-center gap-2 px-2 py-1 text-xs",
                  connected
                    ? "cursor-pointer hover:bg-accent/30"
                    : "cursor-not-allowed",
                )}
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={selected.has(s.id)}
                  onChange={() => toggleSession(s.id)}
                  disabled={!connected}
                />
                {s.type === "ssh" ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: s.host.color }}
                  />
                ) : (
                  <LocalShellIcon
                    kind={s.shell.kind}
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                  />
                )}
                {/* Red, and still listed: a session that has dropped is worth
                    seeing. The row's own title says why it cannot be checked,
                    so this one no longer carries a shorter version of it. */}
                <span
                  className={cn(
                    "truncate",
                    !connected && "text-red-500 dark:text-red-400",
                  )}
                >
                  {sessionLabel(s)}
                </span>
              </label>
            );
          })
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-border/50 p-2">
        {/* The same composer the PTY Broadcast page uses, so Up and Down recall
            the same commands here as they do there. Kept short: this is a rail,
            not a page, and four lines is already a long command. */}
        <div className="flex">
          <Composer
            value={command}
            onChange={setCommand}
            onSubmit={() => void send()}
            history={history}
            maxRows={4}
            placeholder="Command to broadcast"
          />
        </div>
        <Button
          size="sm"
          className="w-full"
          disabled={
            sending || selectedCount === 0 || command.trim().length === 0
          }
          onClick={() => void send()}
        >
          <SendIcon className="h-3.5 w-3.5" />
          Send to {selectedCount}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={history.length === 0}
          onClick={() => void clearCmdHistory()}
          {...hint(
            "Empty the Up/Down recall list. There is only one of them, so this clears the PTY Broadcast page's history too.",
          )}
        >
          <EraserIcon className="h-3.5 w-3.5" />
          Clear history
        </Button>
        <p className="text-[10px] leading-tight text-muted-foreground">
          Types into every checked session. Watch the result in the panes; the
          PTY Broadcast tab keeps the history.
        </p>
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPending(null);
            setGuardHits([]);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {guardHits.length > 0 && (
                <AlertTriangleIcon className="h-4 w-4 text-yellow-500" />
              )}
              {guardHits.length > 0
                ? "This looks destructive"
                : `Run on ${selectedCount} ${
                    selectedCount === 1 ? "shell" : "shells"
                  }?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This runs immediately in every checked session, with no undo.
                </p>
                <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {pending}
                </code>
                {guardHits.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs">
                    {guardHits.map((h) => (
                      <li key={h.rule_id}>{h.description}</li>
                    ))}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmSend}>Send</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
