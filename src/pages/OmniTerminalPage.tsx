import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import {
  omniBlocksAdd,
  omniBlocksClear,
  omniBlocksDelete,
  omniBlocksList,
  omniLogCommand,
  onPtyBlock,
  ptyWrite,
  type BlockInteractivity,
} from "@/lib/tauri/pty";
import { commandHistory } from "@/lib/tauri/settings";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import type { TermSession } from "@/pages/TerminalsPage";

const MIRROR_KEY = "omni-mirror-typed";
const HEADERS_KEY = "omni-headers";
const RAIL_COLLAPSED_KEY = "omni-rail-collapsed";
/** Cap the in-memory block log; the DB keeps up to 1000 (omni_history). */
const MAX_BLOCKS = 500;
/** Colour for a host we can't resolve live (deleted, or a reloaded block). */
const HOST_UNKNOWN_COLOR = "#6b7280";

/** A received/reloaded block plus the bits we render. Colour/label resolve live
 * by `hostId` at render (snapshot is the deletion fallback). */
type DisplayBlock = {
  key: string;
  /** Persisted-row id (set once omni_blocks_add resolves); null until then. */
  dbId: number | null;
  ts: string;
  hostId: number | null;
  labelSnapshot: string;
  colorSnapshot: string;
  command: string | null;
  lines: string[];
  exitCode: number | null;
  durationMs: number | null;
  interactivity: BlockInteractivity;
};

/**
 * OmniTerminal (D-061) — the namesake aggregate view. A command typed here runs
 * through the selected terminals' live shells; each host's whole output drops in
 * as one colour-tinted block in completion order. Full-screen/redrawing apps
 * show an "interactive — not mirrored" notice. The block log persists across
 * restarts. Inert until 2+ terminals are open.
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [blocks, setBlocks] = useState<DisplayBlock[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [guardHits, setGuardHits] = useState<GuardHit[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mirrorTyped, setMirrorTyped] = useState(
    () => localStorage.getItem(MIRROR_KEY) === "1",
  );
  // Headers checkbox (O4): persisted, default ON. Off = blocks show output only.
  const [headers, setHeaders] = useState(
    () => localStorage.getItem(HEADERS_KEY) !== "0",
  );
  // Collapsible selection rail (O1): persisted.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  const [hostsById, setHostsById] = useState<Map<number, Host>>(new Map());
  const hint = useHint();
  const shortcuts = useShortcuts(visible);
  const outputRef = useRef<HTMLDivElement>(null);

  const sessionsById = useMemo(() => {
    const m = new Map<string, TermSession>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  // Gating: the tab is always present but inert until 2+ terminals are open.
  const ready = sessions.length >= 2;

  const selectedConnectedCount = useMemo(
    () =>
      sessions.filter((s) => selected.has(s.id) && connectedSessions.has(s.id))
        .length,
    [sessions, selected, connectedSessions],
  );

  usePageStatus(
    ready
      ? `${selected.size}/${sessions.length} selected · ${selectedConnectedCount} connected`
      : `${sessions.length}/2 terminals open`,
    visible,
  );

  // Selection only ever contains CONNECTED sessions — disconnected ones are
  // ghosted in the rail and can never be a dispatch target (O5). Newly-connected
  // sessions are pre-selected (broadcast-to-all default); the user's unchecks
  // are preserved; a disconnect removes the session from the selection.
  const knownConnected = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const s of sessions) {
        if (!connectedSessions.has(s.id)) continue; // ghost: never selectable
        if (!knownConnected.current.has(s.id) || prev.has(s.id)) next.add(s.id);
      }
      knownConnected.current = new Set(
        sessions.filter((s) => connectedSessions.has(s.id)).map((s) => s.id),
      );
      return next;
    });
  }, [sessions, connectedSessions]);

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
      // A block from a session we dispatched to is "dispatched" (always shown).
      // Pop FIFO rather than matching exact command text — some shells capture
      // the command slightly differently, which previously dropped the block
      // when the mirror toggle was off (O5).
      const queue = pendingDispatched.current.get(blk.session_id);
      let dispatched = false;
      let dispatchedCmd: string | null = null;
      if (queue && queue.length > 0) {
        dispatchedCmd = queue.shift() ?? null;
        dispatched = true;
      }
      // Hand-typed blocks only appear when the mirror toggle is on.
      if (!dispatched && !mirrorRef.current) return;
      // For blocks WE dispatched, trust the command we sent — the parsed echo
      // (blk.command) can be corrupted by recalled/edited input still sitting at
      // the prompt (e.g. an Up-arrow recall of the setup line before dispatch).
      // Hand-typed (mirrored) blocks keep the parsed echo; it's all we have.
      const command = dispatched ? dispatchedCmd : blk.command;
      const ts = new Date().toISOString();
      const key = crypto.randomUUID();
      setBlocks((prev) => {
        const next = [
          ...prev,
          {
            key,
            dbId: null,
            ts,
            hostId: sess.host.id,
            labelSnapshot: sess.host.label,
            colorSnapshot: sess.host.color,
            command,
            lines: blk.lines,
            exitCode: blk.exit_code,
            durationMs: blk.duration_ms,
            interactivity: blk.interactivity,
          },
        ];
        return next.length > MAX_BLOCKS
          ? next.slice(next.length - MAX_BLOCKS)
          : next;
      });
      // Persist so the log survives a restart (best-effort); stash the row id
      // back on the block so it can be individually deleted later.
      omniBlocksAdd({
        ts,
        host_id: sess.host.id,
        label: sess.host.label,
        command,
        lines: blk.lines,
        exit_code: blk.exit_code,
        duration_ms: blk.duration_ms,
        interactivity: blk.interactivity,
      })
        .then((id) =>
          setBlocks((prev) =>
            prev.map((b) => (b.key === key ? { ...b, dbId: id } : b)),
          ),
        )
        .catch(() => {});
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Load the persisted block log + command recall on mount.
  useEffect(() => {
    omniBlocksList(MAX_BLOCKS)
      .then((stored) =>
        setBlocks(
          stored.map((s) => ({
            key: crypto.randomUUID(),
            dbId: s.id,
            ts: s.ts,
            hostId: s.host_id,
            labelSnapshot: s.label,
            colorSnapshot: HOST_UNKNOWN_COLOR,
            command: s.command,
            lines: s.lines,
            exitCode: s.exit_code,
            durationMs: s.duration_ms,
            interactivity: s.interactivity,
          })),
        ),
      )
      .catch(() => {});
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

  const connectedIds = sessions.filter((s) => connectedSessions.has(s.id));
  const allSelected =
    connectedIds.length > 0 && selectedConnectedCount === connectedIds.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(connectedIds.map((s) => s.id)));
  const toggleSession = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleMirror = useCallback(() => {
    setMirrorTyped((prev) => {
      const next = !prev;
      localStorage.setItem(MIRROR_KEY, next ? "1" : "0");
      return next;
    });
  }, []);
  const toggleHeaders = useCallback(() => {
    setHeaders((prev) => {
      const next = !prev;
      localStorage.setItem(HEADERS_KEY, next ? "1" : "0");
      return next;
    });
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  const dispatch = useCallback(
    async (cmd: string) => {
      setSending(true);
      setHistory((prev) => (prev[0] === cmd ? prev : [cmd, ...prev]));
      const targets = sessions.filter(
        (s) => selected.has(s.id) && connectedSessions.has(s.id),
      );
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
    [sessions, selected, connectedSessions],
  );

  const send = useCallback(
    async (cmdOverride?: string) => {
      const cmd = (cmdOverride ?? command).trim();
      if (!cmd || !ready || sending || selectedConnectedCount === 0) return;
      // Same pre-send guard as Broadcast (D-014).
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
    [command, ready, sending, selectedConnectedCount, dispatch],
  );

  const runShortcut = useCallback(
    (cmd: string) => {
      setCommand(cmd);
      send(cmd);
    },
    [send],
  );

  const clearBlocks = useCallback(async () => {
    try {
      await omniBlocksClear();
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    setBlocks([]);
  }, []);

  // Purge a single block (e.g. a stray setup-line capture) without clearing the
  // whole log. Drops the in-memory entry and the persisted row if it has one.
  const deleteBlock = useCallback(async (block: DisplayBlock) => {
    if (block.dbId != null) {
      try {
        await omniBlocksDelete(block.dbId);
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
    }
    setBlocks((prev) => prev.filter((b) => b.key !== block.key));
  }, []);

  const hasOutput = blocks.length > 0;

  return (
    <div className="flex h-full flex-col">
      {!ready && (
        <div className="shrink-0 border-b border-amber-300/70 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
          Open at least 2 terminals (from the Hosts page) to use OmniTerminal.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Session selection rail (collapsible — O1). */}
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
                  : "Collapse the host selection rail",
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
                {...hint("Select or deselect every connected terminal session")}
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={sending || connectedIds.length === 0}
                />
                Select all
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {selected.size}/{sessions.length}
                </span>
              </label>
            )}
          </div>
          {/* pt-2 (not just pb-2) so the first item's selection ring isn't
              clipped by the scroll container's top edge when collapsed. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {sessions.map((s) => {
              const isConnected = connectedSessions.has(s.id);
              const color = hostsById.get(s.host.id)?.color ?? s.host.color;
              const label = hostsById.get(s.host.id)?.label ?? s.host.label;
              if (railCollapsed) {
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => isConnected && toggleSession(s.id)}
                    disabled={sending || !isConnected}
                    title={`${label}${isConnected ? "" : " (disconnected)"}`}
                    className={`mb-1 flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 ${
                      isConnected
                        ? "cursor-pointer hover:bg-accent/50"
                        : "cursor-not-allowed opacity-50"
                    } ${selected.has(s.id) ? "bg-accent/40 ring-1 ring-primary/50" : ""}`}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="font-mono text-[10px] leading-none">
                      {wordInitials(label)}
                    </span>
                  </button>
                );
              }
              return (
                <label
                  key={s.id}
                  title={isConnected ? undefined : "Disconnected — reconnect the terminal to dispatch to it"}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
                    isConnected
                      ? "cursor-pointer hover:bg-accent/50"
                      : "cursor-not-allowed opacity-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={selected.has(s.id)}
                    onChange={() => toggleSession(s.id)}
                    disabled={sending || !isConnected}
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="min-w-0 truncate">{label}</span>
                  <span
                    className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                      isConnected ? "bg-emerald-500" : "bg-red-500/70"
                    }`}
                    title={isConnected ? "Connected" : "Not connected"}
                  />
                </label>
              );
            })}
            {sessions.length === 0 && !railCollapsed && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No open terminal sessions. Open terminals from the Hosts page
                first.
              </p>
            )}
          </div>
        </div>

        {/* Output + composer. */}
        <div className="flex min-w-0 flex-1 flex-col">
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
              Mirror
            </label>
            <label
              className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
              {...hint("Show a host label above each command's output")}
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={headers}
                onChange={toggleHeaders}
              />
              Headers
            </label>
            <div className="ml-auto flex items-center gap-1.5">
              <ShortcutBar
                shortcuts={shortcuts}
                disabled={!ready || sending || selectedConnectedCount === 0}
                onRun={runShortcut}
                onManage={onManageShortcuts}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={clearBlocks}
                disabled={!hasOutput}
                {...hint("Clear the OmniTerminal output log (also clears the saved history)")}
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
                  ? "Type a command below — it runs on every selected terminal and each host's output appears here as it finishes."
                  : "Open at least 2 terminals to use OmniTerminal."}
              </p>
            ) : (
              <div className="space-y-3">
                {blocks.map((b) => {
                  // Live colour by host id (D-061 sub-4); snapshot fallback.
                  const live = b.hostId != null ? hostsById.get(b.hostId) : undefined;
                  const color = live?.color ?? b.colorSnapshot;
                  const label = live?.label ?? b.labelSnapshot;
                  return (
                    <OmniBlock
                      key={b.key}
                      color={color}
                      label={label}
                      command={b.command}
                      ts={b.ts}
                      lines={b.lines}
                      exitCode={b.exitCode}
                      durationMs={b.durationMs}
                      interactivity={b.interactivity}
                      showHeader={headers}
                      onDelete={() => deleteBlock(b)}
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
              disabled={!ready}
              history={history}
              placeholder={
                !ready
                  ? "Open at least 2 terminals to use OmniTerminal…"
                  : selectedConnectedCount === 0
                    ? "Select at least one connected terminal…"
                    : `Run on ${selectedConnectedCount} connected ${selectedConnectedCount === 1 ? "terminal" : "terminals"}…`
              }
            />
            <Button
              onClick={() => send()}
              disabled={
                !ready || sending || !command.trim() || selectedConnectedCount === 0
              }
              aria-label="Send"
              className="h-10"
              {...hint("Run the command on every selected connected terminal")}
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
          .filter((s) => selected.has(s.id) && connectedSessions.has(s.id))
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
  alt_screen: "full-screen program — its output isn't shown here",
  redraw: "live-updating program — its output isn't shown here",
};

/** One completion-ordered, host-tinted output block. */
function OmniBlock({
  color,
  label,
  command,
  ts,
  lines,
  exitCode,
  durationMs,
  interactivity,
  showHeader,
  onDelete,
}: {
  color: string;
  label: string;
  command: string | null;
  ts: string;
  lines: string[];
  exitCode: number | null;
  durationMs: number | null;
  interactivity: BlockInteractivity;
  showHeader: boolean;
  onDelete: () => void;
}) {
  const interactive = interactivity !== "normal";
  return (
    <div
      className="group relative rounded-md border border-border/40 pl-3"
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
    >
      <button
        type="button"
        onClick={onDelete}
        title="Remove this block from the log"
        aria-label="Remove this block"
        className="absolute right-1 top-1 z-10 hidden rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive group-hover:block"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
      {showHeader && (
      <div className="flex items-center gap-2 py-1.5 pl-2 pr-7 text-xs">
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
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
          {!interactive && exitCode !== null && (
            <span className={exitCode === 0 ? "text-emerald-400" : "text-red-400"}>
              exit {exitCode}
            </span>
          )}
          {!interactive && durationMs !== null && (
            <span>{formatDuration(durationMs)}</span>
          )}
          <span>{formatTime(ts)}</span>
        </span>
      </div>
      )}
      {interactive ? (
        <p
          className="px-2 font-mono text-xs italic text-muted-foreground"
          style={{ paddingTop: showHeader ? undefined : "0.375rem", paddingBottom: "0.5rem" }}
        >
          {command ? `${command}: ` : ""}
          {NOTICE[interactivity]}
        </p>
      ) : (
        lines.length > 0 && (
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-xs"
            style={{ color, paddingTop: showHeader ? undefined : "0.375rem" }}
          >
            {lines.join("\n")}
          </pre>
        )
      )}
    </div>
  );
}

/** Human-friendly command duration: `840ms` / `3.2s` / `1m 4s`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/** Short local time (HH:MM:SS) for a block header. */
function formatTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString(undefined, { hour12: false });
}

/** Initials of each whitespace-separated word, for the collapsed rail (O1). */
function wordInitials(label: string): string {
  const i = label
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return i || label.slice(0, 2).toUpperCase();
}
