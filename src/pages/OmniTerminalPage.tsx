import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, SendIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Composer } from "@/components/Composer";
import { ConfirmDestructiveDialog } from "@/components/ConfirmDestructiveDialog";
import { ShortcutBar } from "@/components/ShortcutBar";
import { type GuardHit, checkDestructive } from "@/lib/tauri/broadcast";
import { errorMessage, listHosts, type Host } from "@/lib/tauri/hosts";
import {
  omniLogCommand,
  onPtyBlock,
  ptyWrite,
  type BlockInteractivity,
  type PtyBlock,
} from "@/lib/tauri/pty";
import { commandHistory } from "@/lib/tauri/settings";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import type { TermSession } from "@/pages/TerminalsPage";

const MIRROR_KEY = "omni-mirror-typed";
/** Cap the in-memory block log (kept across tab switches, not restarts). */
const MAX_BLOCKS = 500;

/** A received block plus the bits we render: a stable key, arrival time, the
 * source session, and a host snapshot (deletion fallback — colour/label are
 * resolved live by session at render, falling back to this). */
type DisplayBlock = PtyBlock & {
  key: string;
  ts: string;
  dispatched: boolean;
  labelSnapshot: string;
  colorSnapshot: string;
};

/**
 * OmniTerminal (D-061) — the namesake aggregate view. A command typed here runs
 * through every open terminal's live shell; each host's whole output drops in as
 * one colour-tinted block in completion order (the Broadcast-tab shape, but via
 * the real PTYs). Full-screen/redrawing apps show an "interactive — not
 * mirrored" notice instead of garbage. Inert until 2+ terminals are open.
 */
export function OmniTerminalPage({
  visible,
  sessions,
  connectedSessions,
  onManageShortcuts,
}: {
  visible: boolean;
  sessions: TermSession[];
  connectedSessions: Set<string>;
  onManageShortcuts: () => void;
}) {
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [blocks, setBlocks] = useState<DisplayBlock[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [guardHits, setGuardHits] = useState<GuardHit[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mirrorTyped, setMirrorTyped] = useState(
    () => localStorage.getItem(MIRROR_KEY) === "1",
  );
  // Live host lookup so blocks tint by the host's current colour (D-061
  // sub-4), refreshed when the page is shown.
  const [hostsById, setHostsById] = useState<Map<number, Host>>(new Map());
  const hint = useHint();
  const shortcuts = useShortcuts(visible);
  const outputRef = useRef<HTMLDivElement>(null);

  const sessionsById = useMemo(() => {
    const m = new Map<string, TermSession>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const connectedCount = useMemo(
    () => sessions.filter((s) => connectedSessions.has(s.id)).length,
    [sessions, connectedSessions],
  );

  // Gating: the tab is always present but inert until 2+ terminals are open.
  const ready = sessions.length >= 2;

  usePageStatus(
    ready
      ? `${connectedCount}/${sessions.length} terminals connected`
      : `${sessions.length}/2 terminals open`,
    visible,
  );

  // Refs so the always-on block listener sees current state without re-subscribing.
  const mirrorRef = useRef(mirrorTyped);
  mirrorRef.current = mirrorTyped;
  const sessionsByIdRef = useRef(sessionsById);
  sessionsByIdRef.current = sessionsById;
  // Per-session FIFO queue of commands WE dispatched, so a block can be tagged
  // dispatched (always shown) vs hand-typed (shown only when mirror is on).
  const pendingDispatched = useRef<Map<string, string[]>>(new Map());

  // Subscribe once to every session's block stream.
  useEffect(() => {
    const un = onPtyBlock((blk) => {
      const sess = sessionsByIdRef.current.get(blk.session_id);
      if (!sess) return; // a session we no longer track (closed) — ignore.
      const queue = pendingDispatched.current.get(blk.session_id);
      let dispatched = false;
      if (queue && queue.length && queue[0].trim() === (blk.command ?? "").trim()) {
        queue.shift();
        dispatched = true;
      }
      // Hand-typed blocks only appear when the mirror toggle is on.
      if (!dispatched && !mirrorRef.current) return;
      setBlocks((prev) => {
        const next = [
          ...prev,
          {
            ...blk,
            key: crypto.randomUUID(),
            ts: new Date().toISOString(),
            dispatched,
            labelSnapshot: sess.host.label,
            colorSnapshot: sess.host.color,
          },
        ];
        return next.length > MAX_BLOCKS
          ? next.slice(next.length - MAX_BLOCKS)
          : next;
      });
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Load shared command recall (Up/Down).
  useEffect(() => {
    commandHistory(100)
      .then((entries) => setHistory(entries.map((e) => e.command)))
      .catch(() => {});
  }, []);

  // Refresh live host colours each time the page is shown.
  useEffect(() => {
    if (!visible) return;
    listHosts()
      .then((hs) => setHostsById(new Map(hs.map((h) => [h.id, h] as const))))
      .catch(() => {});
  }, [visible]);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [blocks]);

  const toggleMirror = useCallback(() => {
    setMirrorTyped((prev) => {
      const next = !prev;
      localStorage.setItem(MIRROR_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const dispatch = useCallback(
    async (cmd: string) => {
      setSending(true);
      setHistory((prev) => (prev[0] === cmd ? prev : [cmd, ...prev]));
      const targets = sessions.filter((s) => connectedSessions.has(s.id));
      // Log to the shared command history as `OmniTerminal <hosts> <command>`,
      // tinted live by host (D-061 sub-4). Best-effort — never blocks dispatch.
      omniLogCommand(
        cmd,
        targets.map((s) => ({ id: s.host.id, label: s.host.label })),
      ).catch(() => {});
      for (const s of targets) {
        const queue = pendingDispatched.current.get(s.id) ?? [];
        queue.push(cmd);
        pendingDispatched.current.set(s.id, queue);
        try {
          await ptyWrite(s.id, cmd + "\n");
        } catch (e) {
          queue.pop(); // never landed — don't wait for a block that won't come
          toast.error(`${s.host.label}: ${errorMessage(e)}`);
        }
      }
      setSending(false);
    },
    [sessions, connectedSessions],
  );

  const send = useCallback(
    async (cmdOverride?: string) => {
      const cmd = (cmdOverride ?? command).trim();
      if (!cmd || !ready || sending || connectedCount === 0) return;
      // Same pre-send guard as Broadcast (D-014). The composer line is guarded
      // even though PTY keystrokes are exempt — it's a deliberate one-to-many
      // action, so the guard's spirit applies.
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
      setCommand("");
    },
    [command, ready, sending, connectedCount, dispatch],
  );

  const runShortcut = useCallback(
    (cmd: string) => {
      setCommand(cmd);
      send(cmd);
    },
    [send],
  );

  const hasOutput = blocks.length > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Controls line: mirror toggle (left), shortcut bar + clear (right). */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
        <label
          className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
          {...hint(
            "When on, commands you type by hand inside a terminal tab also appear here. Off = only commands sent from OmniTerminal.",
          )}
        >
          <input
            type="checkbox"
            className="accent-primary"
            checked={mirrorTyped}
            onChange={toggleMirror}
          />
          Mirror commands typed in terminal tabs
        </label>
        <div className="ml-auto flex items-center gap-1.5">
          <ShortcutBar
            shortcuts={shortcuts}
            disabled={!ready || sending || connectedCount === 0}
            onRun={runShortcut}
            onManage={onManageShortcuts}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBlocks([])}
            disabled={!hasOutput}
            {...hint("Clear the OmniTerminal output (this view only)")}
          >
            Clear
          </Button>
        </div>
      </div>

      {/* Block log. */}
      <div ref={outputRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        {!hasOutput ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {ready
              ? "Type a command below — it runs on every connected terminal and each host's output appears here as it finishes."
              : "Open at least 2 terminals (from the Hosts page) to use OmniTerminal."}
          </p>
        ) : (
          <div className="space-y-3">
            {blocks.map((b) => {
              const sess = sessionsById.get(b.session_id);
              // Live colour by host id (D-061 sub-4): live host → open session
              // snapshot → block snapshot, in that order.
              const live = sess ? hostsById.get(sess.host.id) : undefined;
              const color =
                live?.color ?? sess?.host.color ?? b.colorSnapshot;
              const label =
                live?.label ?? sess?.host.label ?? b.labelSnapshot;
              return (
                <OmniBlock
                  key={b.key}
                  color={color}
                  label={label}
                  command={b.command}
                  ts={b.ts}
                  lines={b.lines}
                  exitCode={b.exit_code}
                  interactivity={b.interactivity}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Composer. */}
      <div className="flex items-end gap-2 border-t border-border/50 p-3">
        <Composer
          value={command}
          onChange={setCommand}
          onSubmit={send}
          disabled={!ready || sending}
          history={history}
          placeholder={
            !ready
              ? "Open at least 2 terminals to use OmniTerminal…"
              : connectedCount === 0
                ? "No connected terminals…"
                : `Run on ${connectedCount} connected ${connectedCount === 1 ? "terminal" : "terminals"}…`
          }
        />
        <Button
          onClick={() => send()}
          disabled={!ready || sending || !command.trim() || connectedCount === 0}
          aria-label="Send"
          className="h-10"
          {...hint("Run the command on every connected terminal")}
        >
          {sending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
          Send
        </Button>
      </div>

      <ConfirmDestructiveDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        command={command.trim()}
        hits={guardHits}
        hostLabels={sessions
          .filter((s) => connectedSessions.has(s.id))
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

const NOTICE: Record<Exclude<BlockInteractivity, "normal">, string> = {
  alt_screen: "interactive (full-screen app) — not mirrored",
  redraw: "interactive (live-redrawing) — not mirrored",
};

/** One completion-ordered, host-tinted output block. */
function OmniBlock({
  color,
  label,
  command,
  ts,
  lines,
  exitCode,
  interactivity,
}: {
  color: string;
  label: string;
  command: string | null;
  ts: string;
  lines: string[];
  exitCode: number | null;
  interactivity: BlockInteractivity;
}) {
  const interactive = interactivity !== "normal";
  return (
    <div
      className="rounded-md border border-border/40 pl-3"
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="min-w-0 truncate font-medium" style={{ color }}>
          {label}
        </span>
        {command && (
          <code className="min-w-0 flex-1 truncate rounded bg-muted/40 px-1.5 py-0.5 font-mono text-foreground/80">
            {command}
          </code>
        )}
        {!interactive && exitCode !== null && (
          <span
            className={
              exitCode === 0
                ? "ml-auto shrink-0 tabular-nums text-emerald-400"
                : "ml-auto shrink-0 tabular-nums text-red-400"
            }
          >
            exit {exitCode}
          </span>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatTime(ts)}
        </span>
      </div>
      {interactive ? (
        <p className="px-2 pb-2 font-mono text-xs italic text-muted-foreground">
          {command ? `${command}: ` : ""}
          {NOTICE[interactivity]}
        </p>
      ) : (
        lines.length > 0 && (
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-xs"
            style={{ color }}
          >
            {lines.join("\n")}
          </pre>
        )
      )}
    </div>
  );
}

/** Short local time (HH:MM:SS) for a block header. */
function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString(undefined, { hour12: false });
}
