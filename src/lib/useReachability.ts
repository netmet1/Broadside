import { useEffect, useState } from "react";

import {
  DEFAULT_PROBE_INTERVAL_SECS,
  PROBE_INTERVAL_OFF,
  getHost,
  probeHostReachable,
} from "@/lib/tauri/hosts";

/** How much history the pill reports over, in milliseconds.
 *
 * Two minutes, which at the default three-second interval is 40 probes. Long
 * enough that a single dropped packet does not read as an outage, short enough
 * that what it says is about now rather than about the last hour. */
export const REACHABILITY_WINDOW_MS = 120_000;

/** One probe and when it happened. */
type Sample = { at: number; ok: boolean };

/** What the pill shows before the first probe answers. */
const PENDING: Reachability = {
  ok: 0,
  total: 0,
  percent: 0,
  last: null,
  pending: true,
};

export type Reachability = {
  /** Probes that answered, within the window. */
  ok: number;
  /** Probes made, within the window. */
  total: number;
  /** `ok / total` as a whole percentage. 0 when nothing has been asked yet. */
  percent: number;
  /** True until the first probe lands, i.e. `total` is 0 and the figures mean
   * nothing yet. The pill still draws in this state, and draws as "down": the
   * pane has just lost its connection, so down is the truth until something
   * says otherwise, and a pill that appeared out of nowhere a few seconds later
   * would be a worse answer than one that was there from the start. */
  pending: boolean;
  /** How the most recent probe went. `null` before the first one lands.
   *
   * Kept separate from the percentage on purpose, and it is what the colour
   * follows. The percentage is a reliability figure over two minutes, so a
   * machine that has just finished rebooting reads very low on it for another
   * two minutes: at three seconds a host that came back ten seconds ago is
   * 3/40, which is 7% and would paint red at the exact moment the operator
   * wanted to be told to reconnect. What they asked for was a pill that turns
   * green when the host is ready, and "ready" is the state of the last probe.
   */
  last: boolean | null;
};

/**
 * Ask a host, on a repeat, whether its SSH port is accepting connections.
 *
 * Runs only while `enabled`, which is only while a pane sits on its Reconnect
 * button: this is a poll, and a poll that outlives its reason is a poll nobody
 * remembers turning on. Everything is dropped when it stops, so a tab that
 * reconnects and drops again starts a fresh window rather than showing the
 * failures from last time as though they were current.
 *
 * The interval is the host's own (1-10s, default 3), read when the probing
 * starts rather than passed in from the session's open-time snapshot of the
 * host, so an operator who decides mid-reboot that they want to be asked more
 * often gets it on the next pane rather than the next restart. A host set to
 * off returns null from here, i.e. no pill.
 */
export function useReachability(
  hostId: number | null,
  enabled: boolean,
): Reachability | null {
  // Null when there is nothing to probe, which is a local shell or a pane that
  // is not sitting closed. Used as the identity of "what is being watched": when
  // it changes, everything known about the last thing is wrong.
  const target = enabled && hostId !== null ? hostId : null;

  const [state, setState] = useState<Reachability | null>(
    target === null ? null : PENDING,
  );

  // Reset during render rather than in the effect, which is React's own way of
  // adjusting state when an input changes and the only way that does not trip
  // the compiler's set-state-in-effect rule. It also gets the timing right,
  // which the effect did not: a pane that reconnects and drops again must not
  // show last time's failures for the frame between the two, and an effect runs
  // after that frame has already been painted.
  //
  // The pending value rather than null, so the pill is there from the first
  // frame. A host that is off swallows the connection rather than refusing it,
  // so the first real answer can take the whole timeout to arrive, and the pill
  // would otherwise be missing for several seconds on exactly the hosts it was
  // put there for.
  const [watched, setWatched] = useState(target);
  if (watched !== target) {
    setWatched(target);
    setState(target === null ? null : PENDING);
  }

  useEffect(() => {
    if (!enabled || hostId === null) return;

    // The window is a local of this effect, not a ref. The effect re-runs on
    // exactly the changes that invalidate it -- a different host, or probing
    // stopping and starting -- so a fresh array per run is the behaviour wanted
    // rather than bookkeeping to be got right, and a ref could not be cleared
    // beside the `setState` above without reaching into one during render.
    let samples: Sample[] = [];

    // `cancelled` rather than clearing the timer alone: a probe that is already
    // in flight when the pane reconnects resolves after this effect is torn
    // down, and without the flag it would push a sample into the window of
    // whatever comes next.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const record = (ok: boolean) => {
      const now = Date.now();
      const kept = [
        ...samples.filter((s) => now - s.at < REACHABILITY_WINDOW_MS),
        { at: now, ok },
      ];
      samples = kept;
      const good = kept.filter((s) => s.ok).length;
      setState({
        ok: good,
        total: kept.length,
        percent: Math.round((good / kept.length) * 100),
        last: ok,
        pending: false,
      });
    };

    const run = async (intervalMs: number) => {
      // Awaited, not fired on an interval, so probes cannot overlap. It matters
      // here more than it usually would: a host that is off does not refuse the
      // connection, it swallows it, so each probe against a dead machine runs
      // for its full timeout. On a fixed interval those would stack up.
      let ok = false;
      try {
        ok = await probeHostReachable(hostId);
      } catch {
        // A probe that could not be made is a probe that did not answer. The
        // host being deleted mid-reboot is the realistic case, and there is
        // nothing useful to say about it that "not reachable" does not cover.
        ok = false;
      }
      if (cancelled) return;
      record(ok);
      timer = setTimeout(() => void run(intervalMs), intervalMs);
    };

    void (async () => {
      let secs = DEFAULT_PROBE_INTERVAL_SECS;
      try {
        const host = await getHost(hostId);
        secs = host.probe_interval_secs ?? DEFAULT_PROBE_INTERVAL_SECS;
      } catch {
        // Fall back to the default rather than not probing at all: the reason
        // to read the host was the interval, and not knowing it is no reason to
        // stop answering the question the operator is actually asking.
      }
      if (cancelled) return;
      // Turned off for this host. Null rather than an empty window, so the pane
      // draws no pill at all: a pill reading nothing is a worse answer than no
      // pill, and an operator who asked for it off asked for the space back.
      //
      // This is read here rather than gated by the caller from the session's
      // open-time snapshot of the host, for the same reason the interval is: the
      // setting is meant to take effect on the host, not on the tabs that
      // happened to be open when it was changed. The cost is that the pill draws
      // in its pending state until the host row comes back, which is one local
      // database read and lands well inside a frame.
      if (secs === PROBE_INTERVAL_OFF) {
        setState(null);
        return;
      }
      // Straight into the first probe, with no wait. The pane has just lost its
      // connection, so the first thing anyone wants to know is whether it is
      // already back, and starting with a delay would put the pill's first word
      // several seconds after the banner it sits on.
      await run(secs * 1000);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hostId, enabled]);

  return state;
}
