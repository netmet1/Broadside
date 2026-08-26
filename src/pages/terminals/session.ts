/**
 * What an open terminal tab *is*, and how it is named.
 *
 * Split out of `TerminalsPage` so the pieces that only need "what is this
 * session called" (the maximize banner in App, the broadcast rails) can have it
 * without importing the page component, and so every one of them names a tab
 * the same way. `TerminalsPage` re-exports the types for existing importers.
 */

import type { Host } from "@/lib/tauri/hosts";
import type { LocalShell } from "@/lib/tauri/local";
import type { ShortcutScope } from "@/lib/tauri/settings";

/** An SSH terminal (bound to a saved host) or a local shell (PowerShell / pwsh /
 * Command Prompt / WSL) hosted over ConPTY. Both share the same session id /
 * pty plumbing; only the source and tab affordances differ.
 *
 * `seq` is the monotonic creation order, assigned when the tab opens. It drives
 * the duplicate " 02" suffix and the terminal-pane render order so neither
 * depends on the (drag-reorderable) display order. */
export type SshTermSession = {
  id: string;
  type: "ssh";
  seq: number;
  /** Snapshot of the host at open time (rename/recolor mid-session is fine). */
  host: Host;
  /** This tab adopted a PTY a skill run already had open (its `id` is that
   * backend session id). The first mount skips `pty_open`; a later Reconnect
   * opens a fresh shell to the host. */
  adopted?: boolean;
  /** The skill pane's scrollback as an ANSI string, seeded into the terminal on
   * its first (adopting) mount so the run's history carries over. */
  adoptSnapshot?: string;
  /** Open the tab but not the shell: the pane mounts straight onto its closed
   * banner, waiting on Reconnect. What a template set to "open the tabs at
   * startup" produces, so an unattended launch makes no connections. First
   * mount only; pressing Reconnect opens for real. */
  startClosed?: boolean;
};

export type LocalTermSession = {
  id: string;
  type: "local";
  seq: number;
  shell: LocalShell;
  /** Opened from a saved profile: its working directory, startup command, and
   * name (shown as the tab label so a profile tab is distinguishable from a
   * plain shell tab). Absent for a plain "+" shell open. */
  cwd?: string;
  startupCommand?: string;
  profileLabel?: string;
  /** The launching profile's own colour, `#rrggbb`, when it set one. Overrides
   * the colour the shell's kind would give this tab; empty or absent means the
   * kind's colour applies. See {@link sessionColor}. */
  profileColor?: string;
  /** Operator-set tab name, replacing the derived profile/shell label for the
   * rest of this session. Deliberately not persisted: session ids are fresh
   * UUIDs every run, so a stored name would have nothing to reattach to. */
  title?: string;
  /** Open the tab but not the shell. See {@link SshTermSession.startClosed}. */
  startClosed?: boolean;
};

export type TermSession = SshTermSession | LocalTermSession;

/** How a profile open is described to the App layer when spawning a session. */
export type LocalShellOpenOpts = {
  cwd?: string;
  startupCommand?: string;
  profileLabel?: string;
  profileColor?: string;
};

/** Display label for a tab, regardless of session kind. A renamed local tab
 * shows its operator-set name; a profile-launched one shows the profile's name;
 * a plain one shows the shell name. */
export function sessionLabel(s: TermSession): string {
  if (s.type === "ssh") return s.host.label;
  return s.title || s.profileLabel || s.shell.label;
}

/** What two tabs have to share before one of them is a duplicate of the other:
 * the host for an SSH tab, the shell for a local one. */
function dedupKey(s: TermSession): string {
  return s.type === "ssh" ? `ssh:${s.host.id}` : `local:${s.shell.id}`;
}

/**
 * The " 02", " 03" a tab picks up when it is not the first on its target.
 * Returns a suffix per session id, empty string for the ones that take none.
 *
 * Here rather than in the tab strip because the strip is not the only place
 * duplicates need telling apart, and it turned out to be the least important
 * one: a broadcast list showing `web-01` twice with no way to tell which is
 * which is how a command goes to one machine twice while its operator counts
 * five. The tab strip, a broadcast rail and the MultiTerminal picker all number
 * them the same way, from here.
 *
 * Numbered by creation order (`seq`), not display order, so dragging a tab
 * somewhere else never reshuffles names that are already on screen.
 *
 * A renamed tab consumes its number but shows none: the operator gave it an
 * explicit name, and "Build box 02" would read as a duplicate of a tab that
 * does not exist. Consuming it anyway is what keeps every other tab's number
 * where it was.
 */
export function duplicateSuffixes(
  sessions: readonly TermSession[],
): Map<string, string> {
  const counts = new Map<string, number>();
  const map = new Map<string, string>();
  for (const s of [...sessions].sort((a, b) => a.seq - b.seq)) {
    const key = dedupKey(s);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const renamed = s.type === "local" && !!s.title;
    map.set(s.id, !renamed && n > 1 ? ` ${String(n).padStart(2, "0")}` : "");
  }
  return map;
}

/** How many of these sessions are on a host that another one of them is also
 * on. Zero when every session has a machine to itself.
 *
 * Used to say so, quietly, above a broadcast Send button, because the count on
 * that button is sessions and the number in the operator's head is usually
 * machines. Not to block it: two shells on one box is a normal way to work (a
 * tail in one, the work in the other), and a dialog that fired every time would
 * be one nobody reads by the second week.
 *
 * SSH only, and that is not an oversight. Two local PowerShell tabs are not two
 * ways into one thing, they are two processes with their own working
 * directories; a command sent to both runs once in each and has been sent to
 * exactly as many shells as the button said. Counting them here would raise a
 * warning about the ordinary case of having two shells open. */
export function sessionsSharingAHost(sessions: readonly TermSession[]): number {
  const counts = new Map<number, number>();
  for (const s of sessions) {
    if (s.type !== "ssh") continue;
    counts.set(s.host.id, (counts.get(s.host.id) ?? 0) + 1);
  }
  let shared = 0;
  for (const n of counts.values()) if (n > 1) shared += n;
  return shared;
}

/** Which shortcut scope a tab belongs to. SSH hosts, local WSL tabs and custom
 * POSIX terminals (Git Bash and the like) run Linux commands (ssh); local
 * Command Prompt / PowerShell run Windows ones (local); a serial console has
 * its own scope.
 *
 * Serial used to borrow the `ssh` scope, on the grounds that of two wrong
 * answers the one that never offers a Windows command down a console cable is
 * the better wrong answer. It was still a wrong answer: `ls -la` is no more use
 * to a switch than `dir` is. A cable gets its own scope, no built-in commands,
 * and a picker that greys out until the operator has said what belongs there. */
export function sessionScope(s: TermSession): ShortcutScope {
  if (s.type === "ssh") return "ssh";
  const k = s.shell.kind;
  if (k === "serial") return "serial";
  return k === "wsl" || k === "posix" ? "ssh" : "local";
}

/** The colour a tab wears, or null for the theme's own.
 *
 * One function for both kinds of session so the tab strip, the grid tile header
 * and anything else that tints never have to ask what sort of tab this is. An
 * SSH tab wears its host's colour, which names a machine; a local tab wears its
 * shell's, which names a language; a profile-launched one wears the profile's,
 * because a profile is a purpose and wants telling apart from another profile on
 * the same shell.
 *
 * The colours map is passed in rather than read here: it lives in localStorage
 * and is watched by a hook, and a function the render path calls per tab has no
 * business touching storage. */
export function sessionColor(
  s: TermSession,
  shellColors: Record<string, string | null | undefined>,
): string | null {
  if (s.type === "ssh") return s.host.color;
  return s.profileColor || shellColors[s.shell.kind] || null;
}

/** Most initials we ever show. Camel/word splitting can produce a long run
 * (e.g. "aVeryLongCamelCaseName" → 6), which defeats the point of the compact
 * mode, so the result is trimmed to keep tabs tight. */
const MAX_INITIALS = 4;

/** Break a single word into its parts on camelCase / digit boundaries, keeping
 * runs of capitals together so acronyms stay one part:
 *   "webServer"      → ["web", "Server"]
 *   "XMLHttpRequest" → ["XML", "Http", "Request"]
 *   "SERVER"         → ["SERVER"]   (all-caps: one part → one initial)
 *   "server"         → ["server"]   (all-lowercase: one part → one initial)
 *   "box01"          → ["box", "01"] */
function splitWordParts(word: string): string[] {
  return word.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [];
}

/** Compact-tab initials. Words are separated by spaces, underscores and dashes,
 * and each word is further split on camelCase and letter/digit boundaries; the
 * first character of every part becomes an initial. All-caps, all-lowercase or
 * otherwise single-part words collapse to a single letter (so "PRODSERVER" and
 * "prodserver" both give "P"), and an over-eager camelCase run is trimmed to
 * MAX_INITIALS so a tab never sprouts a long acronym. Examples:
 *   "This is a test"  → "TIAT"      "web-server-01"        → "WS0"
 *   "prod_db_east"    → "PDE"       "myProdBox"            → "MPB"
 *   "aVeryLongName…"  → capped      "PRODSERVER"           → "P" */
export function labelInitials(label: string): string {
  const parts = label
    .split(/[\s_-]+/)
    .filter(Boolean)
    .flatMap(splitWordParts);
  const initials = parts.map((p) => p[0]!.toUpperCase()).join("");
  const trimmed = initials.slice(0, MAX_INITIALS);
  return trimmed || label.slice(0, 2).toUpperCase();
}
