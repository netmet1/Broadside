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
  /** Operator-set tab name, replacing the derived profile/shell label for the
   * rest of this session. Deliberately not persisted: session ids are fresh
   * UUIDs every run, so a stored name would have nothing to reattach to. */
  title?: string;
};

export type TermSession = SshTermSession | LocalTermSession;

/** How a profile open is described to the App layer when spawning a session. */
export type LocalShellOpenOpts = {
  cwd?: string;
  startupCommand?: string;
  profileLabel?: string;
};

/** Display label for a tab, regardless of session kind. A renamed local tab
 * shows its operator-set name; a profile-launched one shows the profile's name;
 * a plain one shows the shell name. */
export function sessionLabel(s: TermSession): string {
  if (s.type === "ssh") return s.host.label;
  return s.title || s.profileLabel || s.shell.label;
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
