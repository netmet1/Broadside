import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  ptyHistoryAdd,
  ptyHistoryClear,
  ptyHistoryList,
  ptyWrite,
} from "@/lib/tauri/pty";
import { clearCommandHistory, commandHistory } from "@/lib/tauri/settings";

const HISTORY_RUNS = 200;

/** Identity of one dispatch target, resolved per session by the panel. For SSH
 * this is the host snapshot (host_id/label/color); for local shells host_id is
 * null and `kind` carries the shell family so the local panel can pick its icon.
 * The optional `kind` is dropped by JSON.stringify on the SSH (persisted) path,
 * so it never reaches the strict `StoredPtyDispatch` backend struct. */
export type DispatchResult = {
  host_id: number | null;
  label: string;
  color: string;
  kind?: string;
  ok: boolean;
  message: string | null;
};

/** One dispatch: a command typed into N sessions, with per-session outcomes.
 * Runs append over time; the SSH panel persists them (D-059), the local panel
 * keeps them in memory only. */
export type RunGroup = {
  runId: string;
  command: string;
  ts: string;
  results: DispatchResult[];
};

/** The subset of a dispatch result the panel supplies per target (the rest —
 * ok/message — is filled in by the send loop). */
type TargetIdentity = Omit<DispatchResult, "ok" | "message">;

/**
 * Shared broadcast state for a set of open PTY sessions: selection, dispatch
 * runs, command-recall history, and the send loop. Both the host-oriented SSH
 * panel and the shell-oriented local panels consume it; the differences are
 * passed in:
 *  - `lineEnding` — SSH keeps the shipped `\n`; local shells need `\r` or
 *    PowerShell/cmd park at a `>>` continuation prompt without executing.
 *  - `persist` — SSH reloads/saves runs + command recall via `ptyHistory*`;
 *    local runs stay in memory (local shells don't survive a restart, so no
 *    backend schema change is needed).
 *  - `describe` — maps a session to its report identity (host snapshot vs
 *    shell icon/label).
 */
export function useSessionBroadcast<T extends { id: string }>({
  sessions,
  connectedSessions,
  lineEnding,
  persist,
  describe,
}: {
  sessions: T[];
  connectedSessions: Set<string>;
  lineEnding: "\r" | "\n";
  persist: boolean;
  describe: (session: T) => TargetIdentity;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  // All dispatch runs, oldest first (newest appended at the bottom).
  const [runs, setRuns] = useState<RunGroup[]>([]);
  const [history, setHistory] = useState<string[]>([]);

  // Nothing is pre-selected — the user opts into each broadcast. Keep their
  // choices; drop any selected id whose session has closed. State persists
  // across tab switches (the page stays mounted) but not restarts.
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(sessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  // Reload persisted dispatch history + command recall on mount (SSH only).
  useEffect(() => {
    if (!persist) return;
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
  }, [persist]);

  const toggleSession = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dispatch = useCallback(
    async (cmd: string) => {
      setSending(true);
      setHistory((prev) => (prev[0] === cmd ? prev : [cmd, ...prev]));
      const targets = sessions.filter((s) => selected.has(s.id));
      const out: DispatchResult[] = [];
      for (const s of targets) {
        const id = describe(s);
        if (!connectedSessions.has(s.id)) {
          out.push({ ...id, ok: false, message: "session is not connected" });
          continue;
        }
        try {
          await ptyWrite(s.id, cmd + lineEnding);
          out.push({ ...id, ok: true, message: null });
        } catch (e) {
          out.push({ ...id, ok: false, message: errorMessage(e) });
        }
      }
      const runId = crypto.randomUUID();
      const ts = new Date().toISOString();
      setRuns((prev) => [...prev, { runId, command: cmd, ts, results: out }]);
      // Persist the run (also records the command in shared recall history).
      if (persist) {
        ptyHistoryAdd({ runId, ts, command: cmd, results: out }).catch(() => {});
      }
      setSending(false);
    },
    [sessions, selected, connectedSessions, lineEnding, persist, describe],
  );

  const clearResults = useCallback(async () => {
    if (persist) {
      try {
        await ptyHistoryClear();
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
    }
    setRuns([]);
    toast.success("Dispatch history cleared");
  }, [persist]);

  const clearCmdHistory = useCallback(async () => {
    if (persist) {
      try {
        await clearCommandHistory();
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
    }
    setHistory([]);
    toast.success("Command history cleared");
  }, [persist]);

  return {
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
    clearCmdHistory,
  };
}
