import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, Loader2Icon, SendIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Composer } from "@/components/Composer";
import { ConfirmDestructiveDialog } from "@/components/ConfirmDestructiveDialog";
import { type GuardHit, checkDestructive } from "@/lib/tauri/broadcast";
import { errorMessage } from "@/lib/tauri/hosts";
import { ptyWrite } from "@/lib/tauri/pty";
import { useHint, usePageStatus } from "@/lib/status";
import type { TermSession } from "@/pages/TerminalsPage";

type DispatchResult = {
  sessionId: string;
  label: string;
  color: string;
  ok: boolean;
  message: string | null;
};

/** PTY Broadcast (work-queue 2026-06-12): mimics the Broadcast page's host
 * selection, but targets the already-open terminal sessions — the command is
 * typed (with Enter) into every checked PTY. This page reports only whether
 * each write was dispatched; the output lives in each terminal tab. */
export function PtyBroadcastPage({
  sessions,
  connectedSessions,
}: {
  sessions: TermSession[];
  /** Session ids with a live connection — only these can receive input. */
  connectedSessions: Set<string>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<DispatchResult[] | null>(null);
  const [guardHits, setGuardHits] = useState<GuardHit[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const hint = useHint();

  // New sessions arrive pre-selected (mirrors Broadcast's select-all default);
  // sessions the user already unchecked stay unchecked.
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

  usePageStatus(
    sessions.length > 0
      ? `${selected.size}/${sessions.length} sessions selected`
      : null,
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
      const targets = sessions.filter((s) => selected.has(s.id));
      const out: DispatchResult[] = [];
      for (const s of targets) {
        if (!connectedSessions.has(s.id)) {
          out.push({
            sessionId: s.id,
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
            sessionId: s.id,
            label: s.host.label,
            color: s.host.color,
            ok: true,
            message: null,
          });
        } catch (e) {
          out.push({
            sessionId: s.id,
            label: s.host.label,
            color: s.host.color,
            ok: false,
            message: errorMessage(e),
          });
        }
      }
      setResults(out);
      setSending(false);
    },
    [sessions, selected, connectedSessions],
  );

  const send = useCallback(async () => {
    const cmd = command.trim();
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
  }, [command, selected, sending, dispatch]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-300/90">
        Sends the command to every checked terminal session as if typed there.
        Results appear in each tab on the Terminals page.
      </div>
      <div className="flex min-h-0 flex-1">
        {/* Session selection rail */}
        <div className="flex w-60 shrink-0 flex-col border-r border-border/50">
          <label
            className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium"
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
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {sessions.map((s) => (
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
                <span className="min-w-0 truncate">{s.host.label}</span>
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
            ))}
            {sessions.length === 0 && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No open terminal sessions. Open terminals from the Hosts page
                first.
              </p>
            )}
          </div>
        </div>

        {/* Dispatch report + composer */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {results === null ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Select sessions, type a command, press Enter. The command is
                typed into every checked terminal.
              </p>
            ) : (
              <div className="space-y-1">
                {results.map((r) => (
                  <div
                    key={r.sessionId}
                    className="flex items-center gap-2 rounded-md border border-border/40 px-3 py-1.5 text-sm"
                  >
                    {r.ok ? (
                      <CheckIcon className="h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <XIcon className="h-4 w-4 shrink-0 text-red-400" />
                    )}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: r.color }}
                    />
                    <span className="min-w-0 truncate font-medium">{r.label}</span>
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      {r.ok ? "sent — see Terminals tab" : r.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-border/50 p-3">
            <Composer
              value={command}
              onChange={setCommand}
              onSubmit={send}
              disabled={sending || sessions.length === 0}
              placeholder={
                sessions.length === 0
                  ? "Open terminal sessions first…"
                  : selected.size === 0
                    ? "Select at least one session…"
                    : `Send to ${selected.size} ${selected.size === 1 ? "session" : "sessions"}…`
              }
            />
            <Button
              onClick={send}
              disabled={sending || !command.trim() || selected.size === 0}
              aria-label="Send"
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
        onConfirmed={() => dispatch(command.trim())}
      />
    </div>
  );
}
