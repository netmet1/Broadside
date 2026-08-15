import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  COMMAND_HISTORY_EVENT,
  type RecallScope,
  announceCommandHistory,
  clearRecall,
  recallFor,
} from "@/lib/commandHistory";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  ptyHistoryAdd,
  ptyHistoryClear,
  ptyHistoryList,
  ptyWrite,
  railLogCommand,
} from "@/lib/tauri/pty";
import { commandHistory } from "@/lib/tauri/settings";

const HISTORY_RUNS = 200;

/** Identity of one dispatch target, resolved per session by the panel. For SSH
 * this is the host snapshot (host_id/label/color); for local shells host_id is
 * null and `kind` carries the shell family so the local panel can pick its icon.
 * The optional `kind` is dropped by JSON.stringify on the SSH (persisted) path,
 * so it never reaches the strict `StoredPtyDispatch` backend struct. */
export type DispatchResult = {
  host_id: number | null;
  label: string;
  /** The " 02" that says which of two sessions on one target this row is, kept
   * out of `label` so it can be dimmed rather than read as part of the name.
   *
   * Joined back onto the label on the way to the database, and only there: a
   * stored row has to make sense on its own, long after the sessions it names
   * have gone. Unpicked again at render, where the live host name says where
   * the name stops and the number starts. */
  suffix?: string;
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

/** The subset of a dispatch result the panel supplies per target (the rest,
 * ok/message, is filled in by the send loop). */
type TargetIdentity = Omit<DispatchResult, "ok" | "message">;

/**
 * Shared broadcast state for a set of open PTY sessions: selection, dispatch
 * runs, command-recall history, and the send loop. Both the host-oriented SSH
 * panel and the shell-oriented local panels consume it; the differences are
 * passed in:
 *  - `lineEnding`: SSH keeps the shipped `\n`; local shells need `\r` or
 *    PowerShell/cmd park at a `>>` continuation prompt without executing.
 *  - `persist`: SSH reloads/saves runs + command recall via `ptyHistory*`;
 *    local runs stay in memory (local shells don't survive a restart, so no
 *    backend schema change is needed).
 *  - `sharedRecall`: whether Up/Down reads the one stored recall list that
 *    every broadcasting screen writes to. Defaults to `persist`, because a
 *    panel that saves its runs was already sharing it; the Terminals rail turns
 *    it on without `persist` (shared recall, no second copy of the runs).
 *  - `recallScope`: which screen this is, for the per-screen clear. Sharing is
 *    for reading only: clearing empties this composer and leaves the others
 *    holding what they had.
 *  - `describe`: maps a session to its report identity (host snapshot vs
 *    shell icon/label).
 */
export function useSessionBroadcast<T extends { id: string }>({
  sessions,
  connectedSessions,
  lineEnding,
  persist,
  sharedRecall = persist,
  recallScope = "ptybroadcast",
  describe,
}: {
  sessions: T[];
  connectedSessions: Set<string>;
  lineEnding: "\r" | "\n";
  persist: boolean;
  sharedRecall?: boolean;
  recallScope?: RecallScope;
  describe: (session: T) => TargetIdentity;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  // All dispatch runs, oldest first (newest appended at the bottom).
  const [runs, setRuns] = useState<RunGroup[]>([]);
  const [history, setHistory] = useState<string[]>([]);

  // Nothing is pre-selected, the user opts into each broadcast. Keep their
  // choices; drop any selected id whose session has closed or dropped its
  // connection. A checked box on a session that cannot receive anything is a
  // command silently going nowhere, so the box is unchecked and (in the panels)
  // disabled while it is down. State persists across tab switches (the page
  // stays mounted) but not restarts.
  // Adjusted during render rather than in an effect: an effect would leave the
  // box ticked for a frame after the session behind it went down, which is the
  // one frame in which a broadcast could be sent to it.
  //
  // Guarded on the *outcome*, not on the inputs. Remembering a copy of the
  // visible set and comparing identities would loop forever the moment that set
  // were rebuilt on each render, because a render-phase update re-runs this
  // component and React does not bail out on an unchanged value the way it does
  // for an update dispatched outside render. Returning the very same set when
  // nothing was dropped makes convergence a property of this code rather than
  // of the memoization somewhere above it.
  const prunedSelected = (() => {
    const live = new Set(
      sessions.filter((s) => connectedSessions.has(s.id)).map((s) => s.id),
    );
    const next = new Set([...selected].filter((id) => live.has(id)));
    return next.size === selected.size ? selected : next;
  })();
  if (prunedSelected !== selected) setSelected(prunedSelected);

  // Reload persisted dispatch history on mount (SSH only).
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
  }, [persist]);

  // The recall list, read on mount and again whenever anything anywhere in the
  // app adds to it. Without the second half, a command sent from one composer
  // would not reach another until a restart. What this screen sees is the part
  // of the list that is newer than its own last clear.
  useEffect(() => {
    if (!sharedRecall) return;
    const load = () => {
      commandHistory(100)
        .then((entries) => setHistory(recallFor(entries, recallScope)))
        .catch(() => {});
    };
    load();
    window.addEventListener(COMMAND_HISTORY_EVENT, load);
    return () => window.removeEventListener(COMMAND_HISTORY_EVENT, load);
  }, [sharedRecall, recallScope]);

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
      // Persist the run, which also records the command in the shared recall
      // list. The rail keeps no runs of its own, so there it is the recall
      // entry alone. Either way the other composers are told to re-read.
      //
      // The number is folded into the label on the way out, in both paths. What
      // is stored is read back weeks later by a log that has no sessions to ask,
      // so "web-01" twice in one run would be a record of a command that looks
      // like it was sent to the same machine twice for no reason. In memory the
      // two stay apart; it is only the written form that joins them.
      const stored = out.map((r) => ({
        ...r,
        label: r.label + (r.suffix ?? ""),
      }));
      if (persist) {
        ptyHistoryAdd({ runId, ts, command: cmd, results: stored })
          .then(announceCommandHistory)
          .catch(() => {});
      } else if (sharedRecall) {
        railLogCommand(
          cmd,
          stored.map((r) => ({ id: r.host_id, label: r.label })),
        )
          .then(announceCommandHistory)
          .catch(() => {});
      }
      setSending(false);
    },
    [
      sessions,
      selected,
      connectedSessions,
      lineEnding,
      persist,
      sharedRecall,
      describe,
    ],
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

  // Shared to read, private to clear: this empties the recall here and leaves
  // the other composers holding what they had. Nothing is deleted, so the Logs
  // page still has the record of what was run.
  const clearCmdHistory = useCallback(async () => {
    if (sharedRecall) clearRecall(recallScope);
    setHistory([]);
    toast.success("Command history cleared here");
  }, [sharedRecall, recallScope]);

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
