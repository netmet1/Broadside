/** Preferences for terminal sessions themselves: when an idle one should be
 * closed, and whether to keep the connection warm.
 *
 * A UI pref in localStorage, per-machine, mirroring gridPrefs and hostColumns.
 * Neither of these belongs to a host: they are about how this copy of Broadside
 * holds a session open, so they are the same for every host you connect to. */

const IDLE_SECS_KEY = "session-idle-timeout-secs";
const IDLE_ON_KEY = "session-idle-timeout-on";
const KEEPALIVE_KEY = "session-keepalive";

/** Fired on this window whenever a session pref is written.
 *
 * The browser's own `storage` event only reaches *other* documents, so a write
 * made here is invisible to the rest of this one. Every open terminal holds its
 * own copy of the timeout, and a change in Settings has to reach the panes that
 * are already open, not just the next one. Same mechanism as GRID_PREFS_EVENT
 * and the same reason. */
export const SESSION_PREFS_EVENT = "broadside:session-prefs";

function announce(): void {
  window.dispatchEvent(new Event(SESSION_PREFS_EVENT));
}

/**
 * Half an hour, in seconds, and off by default.
 *
 * The number is the common one: half an hour is roughly where a shell left at a
 * prompt stops being "I am about to type something" and starts being "I forgot
 * this was open". The *off* is the important half. Closing a live shell is not
 * something to start doing to somebody without being asked, and thirty minutes
 * at a prompt is completely ordinary in the middle of a maintenance window.
 */
export const DEFAULT_IDLE_SECS = 1800;
/** Below this it stops being an idle timeout and starts being a nuisance: a
 * command that prints nothing for half a minute is not rare. */
export const IDLE_SECS_MIN = 30;
/** A day. Past this the setting is not doing anything a human asked for. */
export const IDLE_SECS_MAX = 86_400;

/** How often a keepalive goes out when it is on, in seconds.
 *
 * Not configurable, on purpose. The number only has to be shorter than the
 * shortest idle timeout on the path between here and the host, and the tightest
 * of those in practice is a firewall's 5 minute UDP-ish default applied to TCP
 * state. One minute clears that with room to spare, costs one small packet, and
 * saves a settings row nobody would know how to fill in. */
export const KEEPALIVE_SECS = 60;

export type SessionPrefs = {
  /** Seconds of quiet before an SSH session is closed, or null when off. */
  idleSecs: number | null;
  /** The number the box shows and returns to when the timeout is switched back
   * on. Kept even while off, so turning it off and on again does not lose what
   * you had set. */
  idleDraft: number;
  keepalive: boolean;
};

function readInt(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? clampIdle(n) : fallback;
}

export function clampIdle(secs: number): number {
  return Math.min(IDLE_SECS_MAX, Math.max(IDLE_SECS_MIN, Math.round(secs)));
}

export function loadSessionPrefs(): SessionPrefs {
  const draft = readInt(IDLE_SECS_KEY, DEFAULT_IDLE_SECS);
  const on = localStorage.getItem(IDLE_ON_KEY) === "1";
  return {
    idleSecs: on ? draft : null,
    idleDraft: draft,
    // Default on. It can only ever add one small packet a minute to a link that
    // is already open, and the thing it prevents (a firewall quietly dropping
    // the state table entry for a session you left at a prompt, so the next
    // keystroke goes nowhere and the tab hangs until it times out) is otherwise
    // very hard to tell apart from a broken network.
    keepalive: localStorage.getItem(KEEPALIVE_KEY) !== "0",
  };
}

export function saveIdleSecs(secs: number): void {
  localStorage.setItem(IDLE_SECS_KEY, String(clampIdle(secs)));
  announce();
}

export function saveIdleEnabled(on: boolean): void {
  localStorage.setItem(IDLE_ON_KEY, on ? "1" : "0");
  announce();
}

export function saveKeepalive(on: boolean): void {
  localStorage.setItem(KEEPALIVE_KEY, on ? "1" : "0");
  announce();
}

/** Puts both back to what they ship as: no timeout, keepalive on. */
export function resetSessionPrefs(): void {
  localStorage.removeItem(IDLE_SECS_KEY);
  localStorage.removeItem(IDLE_ON_KEY);
  localStorage.removeItem(KEEPALIVE_KEY);
  announce();
}

/** `1800` as `30m`, `90` as `1m 30s`. For the banner, which has one line to say
 * how long the session sat there. */
export function describeIdle(secs: number): string {
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
