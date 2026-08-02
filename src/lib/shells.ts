/**
 * What a host's login shell means for the features that assume a POSIX one
 * (X4, D-067).
 *
 * Four places tell the operator about this: the chip on the Hosts row, the note
 * in the host form's sudo card, the strip in a terminal pane, and the chips in
 * the broadcast and skills pickers. They share this module so they can't drift
 * into saying four different things.
 *
 * The backend is the authority on what it will and won't send to a shell
 * (`ssh::ShellCapability`); this mirrors that enum for messaging only. Keep the
 * two in step.
 */

/**
 * What the connect-time probe concluded, as stored in `hosts.shell_capability`.
 * `null` means the host has never been probed, which is not a verdict.
 *
 * The two silent values behave identically at the wire and differently to a
 * reader: `unsupported` is a fact with no fix, `unreadable` is a guess the
 * operator can overrule.
 */
export type ShellCapability =
  | "full"
  | "parse_safe"
  | "tail_only"
  | "unsupported"
  | "unreadable";

/** The operator's standing override, from `hosts.shell_integration`. */
export type ShellIntegrationPref = "auto" | "always" | "never";

/** The bare shell name: "/usr/bin/fish" and "fish" both give "fish". */
export function shellName(shell: string): string {
  return shell.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

/** Whether a stored capability means command blocks are tracked, which is what
 * MultiTerminal needs. Only bash and zsh install the OSC 133 hooks. */
export function capabilityTracksBlocks(cap: ShellCapability | null | undefined): boolean {
  if (!cap) return true;
  return cap === "full";
}

/** Whether this host is worth flagging at all. */
export function capabilityIsWarning(cap: ShellCapability | null | undefined): boolean {
  return cap === "tail_only" || cap === "unsupported" || cap === "unreadable";
}

/**
 * The effective capability once the operator's override is applied, which is
 * what actually happens on connect. `always` and `never` are answers in their
 * own right, so a row shows what the host will really do rather than what the
 * probe would have decided on its own.
 */
export function effectiveCapability(
  cap: ShellCapability | null | undefined,
  pref: ShellIntegrationPref | null | undefined,
): ShellCapability | null {
  if (pref === "always") return "full";
  if (pref === "never") return "unsupported";
  return cap ?? null;
}

/**
 * The one explanation, used everywhere a shell is flagged.
 *
 * `shell` is the name the probe read, when it read one. It is absent for both
 * silent cases, which is exactly why the capability has to be passed too.
 */
export function shellCapabilityMessage(
  cap: ShellCapability,
  shell?: string | null,
): string {
  const named = shell ? `${shellName(shell)}` : null;
  switch (cap) {
    case "full":
      return `This host's login shell is ${named ?? "bash or zsh"}. Everything works: command block tracking, skills, broadcast and file transfer.`;
    case "parse_safe":
      return `This host's login shell is ${named ?? "a POSIX shell"}. Command block tracking is limited, because only bash and zsh install the markers Broadside reads. Skills, broadcast, file transfer and sudo auto-fill all work.`;
    case "tail_only":
      return `This host's login shell is ${named ?? "not a Bourne shell"}. Command block tracking is unavailable and skills cannot run here, because that shell cannot read what Broadside sends. Sudo password auto-fill still works, and everything else (terminals, broadcast, file transfer) is unaffected.`;
    case "unsupported":
      return named
        ? `This host's login shell is ${named}, which is not a shell Broadside can drive, so nothing is sent to it and the login screen is left exactly as the host drew it. Command block tracking and skills are unavailable. Terminals, broadcast, file transfer and sudo auto-fill all work.`
        : `This host's login shell is not one Broadside can drive, so nothing is sent to it and the login screen is left exactly as the host drew it. Command block tracking and skills are unavailable. Terminals, broadcast, file transfer and sudo auto-fill all work.`;
    case "unreadable":
      return `Broadside could not read this host's login shell, so it sent nothing rather than guess. Command block tracking and skills are unavailable. If you know this host runs bash or zsh, set Shell integration to Always in the host's settings and both come back.`;
  }
}

/** The short form, for a chip's own label. The two silent cases have no name to
 * show, so they say what happened instead. */
export function capabilityChipLabel(
  cap: ShellCapability,
  shell?: string | null,
): string {
  if (shell) return shellName(shell);
  return cap === "unreadable" ? "shell unread" : "no shell";
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
