/**
 * The Up/Down recall list is one list, in the database, shared by every place
 * that broadcasts a command: the PTY Broadcast page, MultiTerminal, and the
 * broadcast rail on the Terminals page.
 *
 * Sharing the store is not enough on its own, because those screens stay
 * mounted with their own copy of it. A command sent from the rail has to turn
 * up in the PTY Broadcast composer's recall without a restart, and clearing the
 * history in one place has to empty the other. This event is how the other
 * copies find out: the same approach as `GRID_PREFS_EVENT`, and for the same
 * reason (the browser's own `storage` event never reaches the document that
 * wrote).
 */
export const COMMAND_HISTORY_EVENT = "broadside:command-history";

/** Tell every mounted composer to re-read the recall list. */
export function announceCommandHistory(): void {
  window.dispatchEvent(new Event(COMMAND_HISTORY_EVENT));
}
