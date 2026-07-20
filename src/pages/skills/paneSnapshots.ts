/**
 * A tiny registry of "give me this pane's scrollback as text" functions, keyed
 * by PTY session id.
 *
 * When a skill run's shell is handed to a terminal tab, the adopted tab is a
 * brand-new xterm bound to the live byte stream *going forward*: the bytes that
 * already scrolled past live only in the skill pane's own buffer, and the
 * backend does not replay them. So the operator would land in the right shell
 * with an empty backlog, losing every command the skill (or they) had already
 * run. To carry the history across, each `SkillTerminalPane` registers a
 * serializer here on mount; the handoff reads it the instant before it drops the
 * pane, and seeds the new terminal with the result.
 *
 * A module-level map is enough: a session id is globally unique and only one
 * skill pane is ever bound to it at a time. Panes unregister on unmount, so a
 * stale id can never be read.
 */
const snapshots = new Map<string, () => string>();

/** Called by a skill pane on mount: `take` serializes its current buffer. */
export function registerPaneSnapshot(sessionId: string, take: () => string) {
  snapshots.set(sessionId, take);
}

/** Called by a skill pane on unmount, so a dropped pane leaves nothing behind. */
export function unregisterPaneSnapshot(sessionId: string) {
  snapshots.delete(sessionId);
}

/** The pane's current scrollback as an ANSI string, or null if none is bound
 * (or serializing threw). Best-effort: a missing snapshot just means the
 * adopted tab starts empty, exactly as it did before this existed. */
export function takePaneSnapshot(sessionId: string): string | null {
  const take = snapshots.get(sessionId);
  if (!take) return null;
  try {
    return take();
  } catch {
    return null;
  }
}
