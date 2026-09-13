/**
 * The View menu's **Filter**: which kinds of session the Terminals tab shows.
 *
 * Hiding a kind takes its tabs off the strip and its tiles out of the grid, and
 * that is all it does. **A hidden pane is never unmounted**, because unmounting
 * a TerminalView closes its shell; it is laid out as `display: none`, the same
 * way a background tab in Tabs is, and goes on reading output the whole time.
 *
 * Plain component state, not remembered across a restart, like the grid's own
 * hide set. The page stays mounted for the life of the app, so the choice
 * survives every trip to another tab; a restart comes back to everything shown,
 * because a filter left on from last week is a tab you cannot find and no way
 * of knowing why.
 *
 * Three rules keep it from hiding something the operator is reaching for:
 *
 *  - A new session shows its kind again. You just opened it, from the Hosts tab
 *    or the "+" or a template, and a tab that opens hidden is a tab that did not
 *    open as far as anyone can tell.
 *  - Choosing a hidden session from somewhere that can see it (a row in the
 *    Sessions menu, the jump-to icon on PTY Broadcast or MultiTerminal) shows
 *    its kind again, for the same reason.
 *  - The active session is never left on a hidden tab while a visible one
 *    exists. Hiding its kind moves it along, and so does closing a tab when App
 *    picks a hidden neighbour to take its place.
 */

import { useCallback, useLayoutEffect, useMemo, useState } from "react";

import { kindOf } from "@/pages/terminals/sessionKinds";
import type { TermSession } from "@/pages/terminals/session";

export type KindFilter = {
  hiddenKinds: ReadonlySet<string>;
  isHidden: (s: TermSession) => boolean;
  /** The sessions the filter leaves on screen, in tab order. The same array as
   * `sessions` while nothing is hidden. */
  visibleSessions: TermSession[];
  /** Ids of the sessions the filter is hiding, for the grid's tile count. */
  hiddenIds: ReadonlySet<string>;
  /** How many sessions are hidden (not how many kinds). */
  hiddenCount: number;
  toggle: (kind: string) => void;
  showAll: () => void;
  hideAll: () => void;
};

/** The nearest session to `from` whose kind is not hidden, looking right first
 * and then left, a step further each time. Right first because that is where
 * App lands when a tab closes: the neighbour that slid into its place. */
function nearestVisible(
  sessions: readonly TermSession[],
  from: number,
  hidden: ReadonlySet<string>,
): TermSession | undefined {
  for (let d = 1; d < sessions.length; d++) {
    for (const i of [from + d, from - d]) {
      const s = sessions[i];
      if (s && !hidden.has(kindOf(s))) return s;
    }
  }
  return undefined;
}

export function useKindFilter({
  sessions,
  activeId,
  onActivate,
}: {
  sessions: TermSession[];
  activeId: string | null;
  onActivate: (id: string) => void;
}): KindFilter {
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set());

  // The two render-time adjustments below, and why they are not effects: both
  // decide what is on screen, and an effect would paint the wrong answer for a
  // frame first (a new tab missing from the strip, then arriving). Each is
  // React's documented way of adjusting state to a changed prop, and each is
  // guarded on the prop it watches, so it runs once per change and converges.
  // They write one set between them, so the second sees the first's answer.
  const [prevSessions, setPrevSessions] = useState(sessions);
  const [prevActive, setPrevActive] = useState(activeId);
  let next = hiddenKinds;
  const show = (kind: string) => {
    if (!next.has(kind)) return;
    if (next === hiddenKinds) next = new Set(hiddenKinds);
    next.delete(kind);
  };
  if (prevSessions !== sessions) {
    setPrevSessions(sessions);
    if (hiddenKinds.size > 0) {
      // Kinds with nothing open any more, so the set cannot hold a stale kind
      // that would hide the next PowerShell somebody opens next week.
      const open = new Set(sessions.map(kindOf));
      for (const kind of hiddenKinds) if (!open.has(kind)) show(kind);
      // New sessions show their kind.
      const before = new Set(prevSessions.map((s) => s.id));
      for (const s of sessions) if (!before.has(s.id)) show(kindOf(s));
    }
  }
  if (prevActive !== activeId) {
    setPrevActive(activeId);
    const now = sessions.find((s) => s.id === activeId);
    // The one time the active session landing on a hidden tab is not a request
    // to see it: the tab that was active has just closed and App picked its
    // neighbour by position. The layout effect below moves that along instead.
    const previousClosed =
      prevActive !== null && !sessions.some((s) => s.id === prevActive);
    if (now && !previousClosed) show(kindOf(now));
  }
  if (next !== hiddenKinds) setHiddenKinds(next);

  const visibleSessions = useMemo(
    () =>
      hiddenKinds.size === 0
        ? sessions
        : sessions.filter((s) => !hiddenKinds.has(kindOf(s))),
    [sessions, hiddenKinds],
  );
  const hiddenIds = useMemo(
    () =>
      new Set(
        hiddenKinds.size === 0
          ? []
          : sessions.filter((s) => hiddenKinds.has(kindOf(s))).map((s) => s.id),
      ),
    [sessions, hiddenKinds],
  );

  // The active tab closed and its replacement is hidden: go to the nearest one
  // that is not. A layout effect because the active session is App's state and
  // cannot be set from this component's render, and a layout effect still lands
  // before the frame is painted. With every kind hidden there is nowhere to go,
  // and the page says so.
  useLayoutEffect(() => {
    if (activeId === null || hiddenKinds.size === 0) return;
    const at = sessions.findIndex((s) => s.id === activeId);
    if (at === -1 || !hiddenKinds.has(kindOf(sessions[at]!))) return;
    const target = nearestVisible(sessions, at, hiddenKinds);
    if (target) onActivate(target.id);
  }, [activeId, sessions, hiddenKinds, onActivate]);

  /** Apply a new hide set, and move the active session off a tab it just hid,
   * in the same handler so nothing is painted with the ring on a hidden tile. */
  const apply = useCallback(
    (set: Set<string>) => {
      setHiddenKinds(set);
      const at = sessions.findIndex((s) => s.id === activeId);
      if (at === -1 || !set.has(kindOf(sessions[at]!))) return;
      const target = nearestVisible(sessions, at, set);
      if (target) onActivate(target.id);
    },
    [sessions, activeId, onActivate],
  );

  const toggle = useCallback(
    (kind: string) => {
      const set = new Set(hiddenKinds);
      if (!set.delete(kind)) set.add(kind);
      apply(set);
    },
    [hiddenKinds, apply],
  );
  const showAll = useCallback(() => {
    if (hiddenKinds.size > 0) setHiddenKinds(new Set());
  }, [hiddenKinds]);
  const hideAll = useCallback(
    () => apply(new Set(sessions.map(kindOf))),
    [sessions, apply],
  );
  const isHidden = useCallback(
    (s: TermSession) => hiddenKinds.has(kindOf(s)),
    [hiddenKinds],
  );

  return {
    hiddenKinds,
    isHidden,
    visibleSessions,
    hiddenIds,
    hiddenCount: sessions.length - visibleSessions.length,
    toggle,
    showAll,
    hideAll,
  };
}
