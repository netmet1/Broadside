import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_PROBE_INTERVAL_SECS,
  PROBE_INTERVAL_OFF,
  probeHostReachable,
  type Host,
} from "@/lib/tauri/hosts";

/**
 * What the dot beside a node in the skills rail is saying.
 *
 * Five states rather than up/down, because "down" and "nobody is asking" are
 * different answers and a skill fired at a dozen boxes is exactly where the
 * difference costs you. An open terminal outranks a probe: if you are already
 * typing at the machine, no port check is going to tell you something better.
 */
export type NodeStatus =
  /** A terminal to this host is open and connected. */
  | "connected"
  /** Probed, and the last probe answered. */
  | "up"
  /** Probed, and the last probe did not answer. */
  | "down"
  /** Probing, but the first answer has not landed yet. */
  | "checking"
  /** Not being probed at all, and no terminal open: nothing is asking. */
  | "unprobed";

/**
 * The floor this page puts under a host's own probe interval.
 *
 * The per-host setting (1 to 10 seconds, default 3) was tuned for one closed
 * pane watching one machine come back from a reboot, where three seconds is the
 * difference between noticing and staring. This rail asks every saved host at
 * once and nothing here is waiting on a reboot, so the same number would be a
 * connection per host every three seconds for as long as the page is open. A
 * host set slower than this keeps its own interval; the floor only ever asks
 * less often than the setting, never more.
 */
const MIN_INTERVAL_SECS = 15;

/** How many probes may be in the air at once. A host that is off does not
 * refuse the connection, it swallows it, so each probe against a dead machine
 * runs for its full timeout: without a cap, a rack that has been powered down
 * would have every one of its hosts pending at the same time. */
const MAX_IN_FLIGHT = 6;

/**
 * Ask each saved host, on a repeat, whether its SSH port is accepting
 * connections, and fold that together with the terminals already open.
 *
 * Runs only while `enabled`, which is only while the Skills page is the page on
 * screen. The page stays mounted when you navigate away (a run outlives the
 * tab), so without that this would go on probing the whole estate from behind
 * whatever you were actually looking at.
 */
export function useNodeStatus(
  hosts: Host[],
  connectedHostIds: Set<number>,
  enabled: boolean,
): Map<number, NodeStatus> {
  /** The last answer per host id. Absent = not asked yet. */
  const [probed, setProbed] = useState<Map<number, boolean>>(new Map());

  // Who gets asked, and how often. Hosts with probing switched off are left out
  // entirely rather than asked and ignored.
  const plan = useMemo(
    () =>
      hosts
        .map((h) => ({
          id: h.id,
          secs: h.probe_interval_secs ?? DEFAULT_PROBE_INTERVAL_SECS,
        }))
        .filter((p) => p.secs !== PROBE_INTERVAL_OFF)
        .map((p) => ({
          id: p.id,
          ms: Math.max(p.secs, MIN_INTERVAL_SECS) * 1000,
        })),
    [hosts],
  );

  // Everything known is thrown away when the plan changes or probing stops.
  // Adjusted during render, React's own way of resetting state derived from an
  // input, and the only one that does not trip the compiler's set-state-in-effect
  // rule. It matters here: leave the page for twenty minutes and come back, and
  // a kept map would paint twenty-minute-old dots as though they were current.
  const [watched, setWatched] = useState<{
    plan: typeof plan;
    enabled: boolean;
  } | null>(null);
  if (watched === null || watched.plan !== plan || watched.enabled !== enabled) {
    setWatched({ plan, enabled });
    setProbed(new Map());
  }

  useEffect(() => {
    if (!enabled || plan.length === 0) return;

    let cancelled = false;
    let inFlight = 0;
    /** When each host may next be asked. Zero means "now". */
    const due = new Map<number, number>(plan.map((p) => [p.id, 0]));

    const probe = async (id: number, ms: number) => {
      inFlight += 1;
      let ok = false;
      try {
        ok = await probeHostReachable(id);
      } catch {
        // A probe that could not be made is a probe that did not answer. The
        // host being deleted while the page is open is the realistic case.
        ok = false;
      }
      inFlight -= 1;
      if (cancelled) return;
      // Timed from when the answer came back, not from when the question went
      // out: a probe against a dead machine takes its whole timeout, and
      // counting the interval from the start would queue the next one the
      // instant this one gave up.
      due.set(id, Date.now() + ms);
      setProbed((prev) => {
        const next = new Map(prev);
        next.set(id, ok);
        return next;
      });
    };

    const tick = () => {
      const now = Date.now();
      for (const p of plan) {
        if (cancelled || inFlight >= MAX_IN_FLIGHT) break;
        if ((due.get(p.id) ?? 0) > now) continue;
        // Claimed before the probe is sent, not after it answers, so the next
        // tick does not dispatch a second probe to a host still waiting on its
        // first. `probe` pushes it out again once the answer lands.
        due.set(p.id, now + p.ms);
        void probe(p.id, p.ms);
      }
    };

    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [plan, enabled]);

  return useMemo(() => {
    const out = new Map<number, NodeStatus>();
    for (const h of hosts) {
      if (connectedHostIds.has(h.id)) {
        out.set(h.id, "connected");
        continue;
      }
      const secs = h.probe_interval_secs ?? DEFAULT_PROBE_INTERVAL_SECS;
      if (!enabled || secs === PROBE_INTERVAL_OFF) {
        out.set(h.id, "unprobed");
        continue;
      }
      const last = probed.get(h.id);
      out.set(h.id, last === undefined ? "checking" : last ? "up" : "down");
    }
    return out;
  }, [hosts, connectedHostIds, probed, enabled]);
}

/** The dot's colour, and what it means in words, for one status. Kept beside
 * the states themselves so the rail and its legend cannot drift apart: they
 * both read this. */
export const NODE_STATUS_STYLE: Record<
  NodeStatus,
  { dot: string; label: string; title: string }
> = {
  connected: {
    dot: "bg-emerald-500",
    label: "terminal open",
    title: "A terminal to this host is open and connected",
  },
  up: {
    dot: "bg-emerald-800",
    label: "answering",
    title: "The last check found this host's SSH port accepting connections",
  },
  down: {
    dot: "bg-amber-500",
    label: "not answering",
    title: "This host is being checked, and the last check went unanswered",
  },
  checking: {
    dot: "bg-muted-foreground/40",
    label: "checking",
    title: "Checking this host; the first answer has not come back yet",
  },
  unprobed: {
    dot: "bg-red-500/70",
    label: "not checked",
    title:
      "No terminal open, and checking is switched off for this host, so nothing is asking whether it is up",
  },
};

/** Legend order: the two greens, then the two ways of being unavailable, then
 * the transient one. Reads top to bottom as good news to bad. */
export const NODE_STATUS_ORDER: NodeStatus[] = [
  "connected",
  "up",
  "down",
  "unprobed",
  "checking",
];
