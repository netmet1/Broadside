import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  onSkillDone,
  onSkillPaused,
  onSkillProgress,
  runSkill,
  skillCancel,
  type SkillPane,
  type SkillProgress,
} from "@/lib/tauri/skills";

/** One line of a host's run narration, for the pane overlay. */
export type RunLine = { phase: SkillProgress["phase"]; detail: string };

export type HostRunState = {
  pane: SkillPane;
  status: "running" | "paused" | "done" | "failed";
  /** The step the engine is on, for the pane overlay. */
  step: string;
  /** The kind of that step, so the panel can offer step-specific controls. */
  stepKind: SkillProgress["stepKind"];
  /** Set while paused: why the engine stopped and handed over. */
  pausedReason: string | null;
  /** Whether the operator has taken the keyboard for this pane. */
  takenOver: boolean;
  message: string | null;
  lines: RunLine[];
};

/** How much narration to keep per host. A long run is chatty and this all lives
 * in memory (v1 keeps transcripts in the mounted page, not a table). */
const MAX_LINES = 500;

/**
 * The live state of one skill run, assembled from `skill:progress` /
 * `skill:paused` / `skill:done`.
 *
 * The page stays mounted, so a run survives tab switches, but not a restart
 * (v1 decision). Listeners are registered for the page's whole life rather than
 * per run: events for a finished run are simply ignored.
 */
export function useSkillRun() {
  const [runId, setRunId] = useState<string | null>(null);
  const [hosts, setHosts] = useState<Map<number, HostRunState>>(new Map());
  const [starting, setStarting] = useState(false);
  // Read inside event handlers that must not re-subscribe on every run.
  const runIdRef = useRef<string | null>(null);
  runIdRef.current = runId;
  /** Hosts whose panes have landed, so patch knows what it can apply now. */
  const knownRef = useRef<Set<number>>(new Set());
  /** Updates for a host whose pane hasn't arrived yet, replayed once it does. */
  const pendingRef = useRef<Map<number, ((prev: HostRunState) => HostRunState)[]>>(
    new Map(),
  );

  const patch = useCallback(
    (hostId: number, fn: (prev: HostRunState) => HostRunState) => {
      // An event can beat its own pane here: the backend starts driving hosts
      // inside run_skill, before the call that hands back the panes has
      // returned. Dropping those would leave a host that fails instantly
      // sitting on "running" with no way to close the run, so hold them.
      if (!knownRef.current.has(hostId)) {
        const queued = pendingRef.current.get(hostId) ?? [];
        queued.push(fn);
        pendingRef.current.set(hostId, queued);
        return;
      }
      setHosts((prev) => {
        const cur = prev.get(hostId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(hostId, fn(cur));
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    const subs = [
      onSkillProgress((p) => {
        if (p.runId !== runIdRef.current) return;
        patch(p.hostId, (prev) => ({
          ...prev,
          // A progress event means the engine is driving again, so a pause is
          // over. Resuming clears the takeover banner without a round trip.
          status: prev.status === "paused" ? "running" : prev.status,
          pausedReason: null,
          takenOver: false,
          step: p.phase === "step" ? p.detail : prev.step,
          stepKind: p.phase === "step" ? p.stepKind : prev.stepKind,
          lines: [...prev.lines, { phase: p.phase, detail: p.detail }].slice(
            -MAX_LINES,
          ),
        }));
      }),
      onSkillPaused((p) => {
        if (p.runId !== runIdRef.current) return;
        patch(p.hostId, (prev) => ({
          ...prev,
          status: "paused",
          pausedReason: p.reason,
        }));
      }),
      onSkillDone((p) => {
        if (p.runId !== runIdRef.current) return;
        patch(p.hostId, (prev) => ({
          ...prev,
          status: p.ok ? "done" : "failed",
          pausedReason: null,
          message: p.message,
          lines: [
            ...prev.lines,
            { phase: p.ok ? ("info" as const) : ("failed" as const), detail: p.message },
          ].slice(-MAX_LINES),
        }));
      }),
    ];
    return () => {
      for (const s of subs) void s.then((fn) => fn());
    };
  }, [patch]);

  const start = useCallback(
    async (args: {
      skillId: number;
      hostIds: number[];
      params: Record<string, string>;
      confirmed: boolean;
      cols: number;
      rows: number;
    }): Promise<boolean> => {
      const id = crypto.randomUUID();
      // Claim the id before the call, not after. The backend spawns its host
      // tasks inside run_skill and they can emit before the invoke has even
      // resolved; a ref that only catches up on the next render would drop
      // those events, and a host whose very first event is its last (a
      // credentials failure, say) would sit on "running" forever.
      runIdRef.current = id;
      setStarting(true);
      try {
        const panes = await runSkill({ runId: id, ...args });
        setRunId(id);
        const seeded = new Map<number, HostRunState>(
          panes.map((pane) => [
            pane.hostId,
            {
              pane,
              status: "running" as const,
              step: "starting…",
              stepKind: null,
              pausedReason: null,
              takenOver: false,
              message: null,
              lines: [],
            },
          ]),
        );
        knownRef.current = new Set(seeded.keys());
        // Replay anything that arrived while we were still waiting for the panes.
        for (const [hostId, queued] of pendingRef.current) {
          const cur = seeded.get(hostId);
          if (cur) seeded.set(hostId, queued.reduce((acc, fn) => fn(acc), cur));
        }
        pendingRef.current.clear();
        setHosts(seeded);
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      } finally {
        setStarting(false);
      }
    },
    [],
  );

  /** Marks every unfinished host as finished, so the UI can always be escaped.
   *
   * The backend is meant to report every host, but "meant to" is how an
   * operator ends up staring at a pane that says it is waiting for them while
   * every button answers that the run already ended. Nothing here can strand
   * the run; the worst case is a pane marked finished slightly early. */
  const forceFinish = useCallback((message: string) => {
    setHosts((prev) => {
      const next = new Map(prev);
      for (const [hostId, h] of prev) {
        if (h.status === "running" || h.status === "paused") {
          next.set(hostId, {
            ...h,
            status: "failed",
            pausedReason: null,
            takenOver: false,
            message,
          });
        }
      }
      return next;
    });
  }, []);

  /** Marks one host finished, for when its controls report it already ended. */
  const finishHost = useCallback(
    (hostId: number, message: string) =>
      patch(hostId, (prev) => ({
        ...prev,
        status: "failed",
        pausedReason: null,
        takenOver: false,
        message,
      })),
    [patch],
  );

  /** Emergency stop. Irreversible: kills every host mid-step. */
  const cancelAll = useCallback(async () => {
    const id = runIdRef.current;
    if (!id) return;
    try {
      await skillCancel(id);
      toast.warning("Emergency stop. Every host was killed mid-sequence.");
    } catch (e) {
      toast.error(errorMessage(e));
    }
    // Whatever the backend had left to kill, this run is over as far as the
    // operator is concerned. Settling the panes here means an emergency stop
    // always gets them out, even if the backend had already lost track of the
    // run and had nothing left to cancel.
    forceFinish("stopped by the emergency stop");
  }, [forceFinish]);

  const setTakenOver = useCallback(
    (hostId: number, takenOver: boolean) =>
      patch(hostId, (prev) => ({ ...prev, takenOver })),
    [patch],
  );

  /** Clears a finished run so the page returns to the picker. */
  const reset = useCallback(() => {
    setRunId(null);
    setHosts(new Map());
    runIdRef.current = null;
    knownRef.current = new Set();
    pendingRef.current.clear();
  }, []);

  const hostList = [...hosts.values()];
  const active = hostList.some(
    (h) => h.status === "running" || h.status === "paused",
  );

  return {
    runId,
    hosts: hostList,
    active,
    starting,
    start,
    cancelAll,
    finishHost,
    setTakenOver,
    reset,
  };
}
