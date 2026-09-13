/**
 * Warnings the operator has told Broadside to stop showing.
 *
 * A "do not warn me again" checkbox is a reasonable thing to offer on a dialog
 * somebody will see every time they save the same template. A security warning
 * that can be silenced forever with **no way back** is not: the person who
 * ticks the box is rarely the person who later inherits the machine, and by
 * then nothing on screen says a warning was ever there. So every dismissal is
 * recorded here by name, and Settings has one control that puts them all back.
 *
 * localStorage, per machine, alongside the other view preferences. This is a
 * choice about what to show, not about what is allowed: nothing here can turn
 * an action into one that does not need confirming, only into one that does not
 * explain itself first. The dialogs that genuinely gate an action (the
 * destructive-command guard, the admin lock) do not use this and never should.
 */

const KEY = "dismissed-warnings";

/** The warnings that can be dismissed, by id.
 *
 * Each one is a full sentence rather than a slug because Settings lists them
 * back: an operator restoring warnings wants to know which ones they turned
 * off, and "template-startup-connect" tells them nothing. */
export const DISMISSIBLE_WARNINGS = [
  {
    id: "template-startup-connect",
    label: "Connecting a template at startup",
    detail:
      "Shown when a template is saved with 'launch and connect at startup', which opens SSH sessions before anyone has looked at the screen.",
  },
  {
    id: "template-export-refs",
    label: "Exporting a template's host references",
    detail:
      "Shown when a template is exported, because the hosts it names may not exist on the machine that imports it.",
  },
] as const;

export type WarningId = (typeof DISMISSIBLE_WARNINGS)[number]["id"];

/** Fired on this window whenever the set changes, because Settings and the page
 * that raised the warning are both mounted at once and the browser's own
 * `storage` event only reaches *other* documents. Without this, restoring the
 * warnings would not take effect until the app restarted. */
export const DISMISSED_WARNINGS_EVENT = "broadside:dismissed-warnings";

function read(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(raw)) {
      return new Set(raw.filter((x): x is string => typeof x === "string"));
    }
  } catch {
    // A corrupt blob costs the dismissals, which fails towards showing the
    // warning. That is the right way for this one to fail.
  }
  return new Set();
}

function write(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // A full or disabled store costs the choice, never the action.
  }
  window.dispatchEvent(new Event(DISMISSED_WARNINGS_EVENT));
}

export function isWarningDismissed(id: WarningId): boolean {
  return read().has(id);
}

export function dismissWarning(id: WarningId): void {
  const ids = read();
  if (ids.has(id)) return;
  ids.add(id);
  write(ids);
}

/** Which warnings are currently silenced. Settings shows this so the control
 * can say how many there are to restore. */
export function dismissedWarnings(): Set<string> {
  return read();
}

/** Show them all again. */
export function restoreWarnings(): void {
  write(new Set());
}
