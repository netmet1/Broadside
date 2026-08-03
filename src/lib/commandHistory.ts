/**
 * The Up/Down recall list is one list, in the database, shared by every place
 * that broadcasts a command: the PTY Broadcast page, MultiTerminal, and the
 * broadcast rail on the Terminals page.
 *
 * Sharing the store is not enough on its own, because those screens stay
 * mounted with their own copy of it. A command sent from the rail has to turn
 * up in the PTY Broadcast composer's recall without a restart. This event is
 * how the other copies find out: the same approach as `GRID_PREFS_EVENT`, and
 * for the same reason (the browser's own `storage` event never reaches the
 * document that wrote).
 *
 * Clearing, though, is *not* shared. Pressing Clear on one screen empties that
 * screen's recall and leaves everyone else's alone, so tidying the box in front
 * of you is never an act on someone else's tab. That is done with a cutoff time
 * per screen rather than by deleting rows: each screen recalls the commands
 * newer than the last time it was cleared. Nothing leaves the database, so the
 * Logs page's record of what was run is untouched by a recall clear, which is
 * as it should be. The Logs page's own Clear history really does delete, and
 * every composer goes quiet because there is then nothing newer than anything.
 */
export const COMMAND_HISTORY_EVENT = "broadside:command-history";

/** Which composer is asking. One cutoff each. */
export type RecallScope =
  | "broadcast"
  | "ptybroadcast"
  | "multiterminal"
  | "terminals";

const CUTOFF_KEY = (scope: RecallScope) => `command-recall-cutoff-${scope}`;

/** Tell every mounted composer to re-read the recall list. */
export function announceCommandHistory(): void {
  window.dispatchEvent(new Event(COMMAND_HISTORY_EVENT));
}

/** Epoch milliseconds this screen was last cleared at, or 0 if it never was.
 * A time and not a row id: the history table's ids restart from 1 if the whole
 * table is ever deleted, and a stale id cutoff would then hide everything that
 * came after. */
function cutoff(scope: RecallScope): number {
  const raw = localStorage.getItem(CUTOFF_KEY(scope));
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** The commands this screen should recall: everything sent since it was last
 * cleared, whoever sent it. An entry with an unreadable timestamp is kept:
 * better a stale line in the recall than a silently missing one. */
export function recallFor(
  entries: { command: string; ts: string }[],
  scope: RecallScope,
): string[] {
  const since = cutoff(scope);
  if (since === 0) return entries.map((e) => e.command);
  return entries
    .filter((e) => {
      const t = Date.parse(e.ts);
      return !Number.isFinite(t) || t > since;
    })
    .map((e) => e.command);
}

/** Empty this screen's recall, and only this one. Survives a restart. */
export function clearRecall(scope: RecallScope): void {
  localStorage.setItem(CUTOFF_KEY(scope), String(Date.now()));
}
