/**
 * Which open sessions MultiTerminal is currently copying hand-typed work from.
 *
 * **Show Manual Activity** on the MultiTerminal page means a command typed by
 * hand into a terminal tab is also written into that page's block log, and into
 * the omni-block table on disk with it. It is off by default, it is a checkbox
 * on a page the operator may not be looking at, and it only applies to the
 * hosts checked on that page's rail. So from inside a terminal there was
 * nothing at all to say it was on: you could type in what read as a private
 * shell and have every command land in a log somewhere else.
 *
 * The two pages are siblings that both stay mounted for the life of the app
 * (see `App.tsx`), so this is one fact they have to agree on. A module-level
 * store rather than a context or a prop: MultiTerminal owns the answer and
 * publishes it, the tab strip reads it, and nothing on the path between them
 * has to carry a value for something neither of them renders.
 */

import { useSyncExternalStore } from "react";

const EMPTY: ReadonlySet<string> = new Set();

let mirrored: ReadonlySet<string> = EMPTY;
const listeners = new Set<() => void>();

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Publish the set of session ids being mirrored. Empty when the toggle is off.
 *
 * Membership decides whether this is a change, not identity: `useSyncExternalStore`
 * compares snapshots by identity and re-renders every reader when one differs,
 * and the caller builds this set on a page that re-renders on every block that
 * arrives. Without the comparison the tab strip would re-render along with it.
 */
export function setMirroredSessions(next: ReadonlySet<string>): void {
  if (sameMembers(mirrored, next)) return;
  mirrored = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ReadonlySet<string> {
  return mirrored;
}

/** The live set, for anything that wants to mark a session as being copied. */
export function useMirroredSessions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot);
}
