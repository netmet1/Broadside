/**
 * What a host's login shell means for the features that assume a POSIX one
 * (X4).
 *
 * Three places tell the operator about this: the chip on the Hosts row, the
 * note in the host form's sudo card, and the strip in a terminal pane. They
 * share this module so they can't drift into saying three different things.
 *
 * The backend is the authority on what it will and won't send to a shell
 * (`ssh::shell_can_parse_integration`); this mirrors that list for messaging
 * only. Keep the two in step.
 */

/** Shells that take the OSC 133 integration, so command block tracking works. */
const FULLY_SUPPORTED = ["bash", "zsh"];

/** Shells that at least parse what we send them, even if they install no hooks. */
const POSIX_COMPATIBLE = [
  ...FULLY_SUPPORTED,
  "sh",
  "dash",
  "ash",
  "ksh",
  "ksh93",
  "mksh",
  "pdksh",
];

/** The bare shell name: "/usr/bin/fish" and "fish" both give "fish". */
export function shellName(shell: string): string {
  return shell.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

/**
 * Whether this shell is one Broadside works fully with. An unprobed host
 * (null) is NOT unsupported: we simply don't know, and warning on a guess
 * would nag every host on a server that won't answer the probe.
 */
export function isShellSupported(shell: string | null | undefined): boolean {
  if (!shell) return true;
  return POSIX_COMPATIBLE.includes(shellName(shell));
}

/** Whether skills can run here. Stricter than the above: the engine needs `$?`,
 * `$(...)` and `;` to behave the Bourne way. */
export function shellRunsSkills(shell: string | null | undefined): boolean {
  if (!shell) return true;
  return ["bash", "zsh", "sh"].includes(shellName(shell));
}

/** The one explanation, used everywhere an unsupported shell is flagged. */
export function unsupportedShellMessage(shell: string): string {
  return (
    `This host's login shell is ${shellName(shell)}. Command block tracking ` +
    `is unavailable on this host and skills cannot run on it. Sudo password ` +
    `auto-fill still works, and everything else (terminals, broadcast, file ` +
    `transfer) is unaffected.`
  );
}

/** The short form, for a chip's own label. */
export function shellChipLabel(shell: string): string {
  return shellName(shell);
}

/* Which hosts have had the terminal-pane warning dismissed. A UI pref, stored
 * the same way as the hidden host columns (see `hostColumns.ts`), so opening a
 * fifth tab on a known fish host doesn't nag a fifth time. Cleared by the
 * Settings reset along with the rest of the UI prefs. */

const DISMISSED_KEY = "shell-warning-dismissed";

export function loadDismissedShellWarnings(): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    if (Array.isArray(raw)) return new Set(raw.filter((x) => typeof x === "number"));
  } catch {
    // Fall through to an empty set: worst case the operator sees it once more.
  }
  return new Set();
}

export function dismissShellWarning(hostId: number): void {
  const next = loadDismissedShellWarnings();
  next.add(hostId);
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
}
