/**
 * A colour for a local terminal tab, the way a host has one.
 *
 * A saved host carries a colour, and the tab strip and the grid tiles use it:
 * the active tab takes a wash of it and a bar along its top, so a rack of open
 * sessions can be told apart at a glance rather than by reading. Local tabs had
 * none of that. Every PowerShell, Command Prompt, WSL and serial tab was the
 * same theme grey, which is fine with two of them open and no help at all with
 * ten.
 *
 * The unit of colour here is the **kind of shell**, not the individual tab, and
 * that is the whole design rather than a shortcut. A host's colour says *which
 * machine*; a local tab has no machine to name, so the useful thing for it to
 * say is *what language am I about to type in*, which is exactly what stops a
 * `rm -rf` going into a Command Prompt or a `dir` into WSL. Two PowerShell tabs
 * being the same colour is not a defect: they are the same thing.
 *
 * A saved **profile** is the exception, and overrides its shell's colour. A
 * profile is not a language, it is a purpose ("Broadside dev", "prod tunnel"),
 * which is the same kind of thing a host is, so it gets the same freedom.
 *
 * localStorage, alongside {@link ./localShellPrefs} and {@link ./gridPrefs},
 * because this is presentation and nothing else. Custom terminals live in the
 * database because a row there names an executable to spawn; a colour names
 * nothing and can never be dangerous, so it does not need the trip.
 */

/** The shell kinds a colour can be set for. These are `LocalShell.kind` values,
 * so a custom terminal takes the colour of the language it declares: Git Bash
 * and MSYS2 are both `posix` and both wear the POSIX colour, which is the point
 * (they are the same language) rather than a limitation. */
export const SHELL_KINDS = [
  "powershell",
  "cmd",
  "wsl",
  "posix",
  "serial",
] as const;

export type ShellKind = (typeof SHELL_KINDS)[number];

/** What each kind is called where the colour is chosen. */
export const SHELL_KIND_LABELS: Record<ShellKind, string> = {
  powershell: "PowerShell",
  cmd: "Command Prompt",
  wsl: "WSL",
  posix: "Bash-like (Git Bash, MSYS2, Cygwin)",
  serial: "Serial console",
};

/**
 * The colours a fresh install starts with.
 *
 * Blues, and dark ones, on purpose: they are the Windows console family
 * (`#012456` is PowerShell's own console background, and the rest sit around
 * it), and a terminal tab wearing a colour is wearing it at about a fifth
 * strength behind text that still has to be readable in both themes. The host
 * palette's reds and greens are far too loud for a strip of them, and they are
 * also spoken for: a red dot on this page means a host, and a local tab
 * borrowing it would be saying something it does not mean.
 *
 * Serial starts with **no colour at all**, which is how it shipped and how it
 * should stay by default. A console cable is the one session that is a piece of
 * hardware rather than a program, it already has an icon nothing else uses, and
 * leaving it plain is what makes it obvious that the coloured tabs are the
 * shells. Anyone who wants one can set it.
 */
export const DEFAULT_SHELL_COLORS: Record<ShellKind, string | null> = {
  powershell: "#012456",
  cmd: "#0f3d6b",
  wsl: "#1b6aa5",
  posix: "#2e4a7d",
  serial: null,
};

/** A hex colour the tab tint can actually use. The `${c}33` alpha suffix and
 * the CSS border only work on a full six-digit hex, so a three-digit one (which
 * the Hosts form accepts) or anything else is treated as no colour rather than
 * being half-applied. */
export function isTintable(color: string | null | undefined): color is string {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

const KEY = "terminal-kind-colors";

/** Only what the operator has changed is stored, so a default that is improved
 * in a later version reaches everyone who never touched it. A stored `null` is
 * a deliberate "no colour" and is kept as such; an absent key means "whatever
 * the default is". That distinction is why this is not simply a colour map. */
type StoredColors = Partial<Record<ShellKind, string | null>>;

function readStored(): StoredColors {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: StoredColors = {};
    for (const kind of SHELL_KINDS) {
      const v: unknown = (parsed as Record<string, unknown>)[kind];
      if (v === null) out[kind] = null;
      else if (typeof v === "string" && isTintable(v)) out[kind] = v;
    }
    return out;
  } catch {
    // A corrupt blob costs the colours, never the terminals.
    return {};
  }
}

/** The colour for every kind: the operator's choice where they made one, the
 * built-in default everywhere else. */
export function loadShellColors(): Record<ShellKind, string | null> {
  const stored = readStored();
  const out = {} as Record<ShellKind, string | null>;
  for (const kind of SHELL_KINDS) {
    out[kind] = kind in stored ? stored[kind]! : DEFAULT_SHELL_COLORS[kind];
  }
  return out;
}

/** Persist the full map, dropping entries that match the default so an
 * untouched kind keeps following it. */
export function saveShellColors(colors: Record<ShellKind, string | null>): void {
  const stored: StoredColors = {};
  for (const kind of SHELL_KINDS) {
    if (colors[kind] !== DEFAULT_SHELL_COLORS[kind]) stored[kind] = colors[kind];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // A full or disabled store costs the choice, never the session.
  }
}

/** Fired on `window` after a save, because Settings and the Terminals page are
 * both mounted at once and the browser's own `storage` event only reaches
 * *other* tabs, never the one that wrote. Without this a colour change would
 * not show until the app restarted. */
export const SHELL_COLORS_CHANGED = "broadside:shell-colors-changed";

export function notifyShellColorsChanged(): void {
  window.dispatchEvent(new Event(SHELL_COLORS_CHANGED));
}
