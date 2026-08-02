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
      return `This host's login shell is ${named ?? "a POSIX shell"}. Command blocks are not tracked: only bash and zsh install the markers. All else works.`;
    case "tail_only":
      return `This host's login shell is ${named ?? "not a Bourne shell"}. No command blocks and no skills. Terminals, broadcast and transfers all work.`;
    case "unsupported":
      return named
        ? `This host's login shell is ${named}, which Broadside cannot drive, so it sends nothing at all. No command blocks and no skills.`
        : `This host's login shell is not one Broadside can drive, so it sends nothing at all. No command blocks and no skills.`;
    case "unreadable":
      return `Broadside could not read this host's login shell, so it sent nothing. Set Shell integration to Always if it runs bash or zsh.`;
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

/**
 * What to say about a flagged host, in one place, from the pair that decides
 * it: the probe's verdict and the operator's override. `null` means there is
 * nothing to say.
 *
 * The chip on a Hosts row and the strip at the foot of a terminal pane are the
 * same statement in two sizes, so they resolve the override the same way. The
 * strip used to work from the probe's verdict alone, which meant the setting
 * could be changed from Auto to Never and back with the pane saying nothing
 * either time: on a bash host there was no warning to change, and on a fish
 * host the verdict it had been dismissed for never moved.
 *
 * `key` is what a dismissal is remembered against. It is the verdict as the
 * reader met it, so `never` is its own key rather than the `unsupported` it
 * resolves to: those two are different sentences, and dismissing one must not
 * silence the other.
 */
export function shellNotice(
  capability: ShellCapability | null | undefined,
  pref: ShellIntegrationPref | null | undefined,
  loginShell: string | null | undefined,
): { key: string; label: string; message: string } | null {
  const effective = effectiveCapability(capability, pref);
  if (!capabilityIsWarning(effective)) return null;
  // `effective` is a warning, so it is not null — narrowed for the helpers.
  const cap = effective as ShellCapability;
  if (pref === "never") {
    return {
      key: "never",
      label: "no integration",
      message:
        "Shell integration is set to Never here, so nothing is sent to its shell. No command blocks and no skills. Change it in Hosts.",
    };
  }
  // A name is only worth showing when it is the host's own answer.
  return {
    key: cap,
    label: capabilityChipLabel(cap, loginShell),
    message: shellCapabilityMessage(cap, loginShell),
  };
}

/* Which hosts have had the terminal-pane warning dismissed, and for *which
 * verdict*. A UI pref, stored the same way as the hidden host columns (see
 * `hostColumns.ts`), so opening a fifth tab on a known fish host doesn't nag a
 * fifth time. Cleared by the Settings reset along with the rest of the UI prefs.
 *
 * Keyed by capability as well as host because the verdict can change and the
 * new one is news: a host that was bash and is now behind a console menu, or
 * one just set to Never, has something to say that was never dismissed. Storing
 * the host alone made "dismissed" permanent and unreachable — there was no way
 * back short of resetting every preference in the app. The key is versioned
 * rather than migrated: the old shape said nothing about which verdict was
 * dismissed, so there is nothing in it to carry forward. */

const DISMISSED_KEY = "shell-warning-dismissed-v2";

function loadDismissed(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, string>;
    }
  } catch {
    // Fall through to empty: worst case the operator sees it once more.
  }
  return {};
}

/** Whether this host's warning has already been dismissed *for this verdict*.
 * `key` comes from [`shellNotice`]. */
export function shellWarningDismissed(hostId: number, key: string): boolean {
  return loadDismissed()[String(hostId)] === key;
}

export function dismissShellWarning(hostId: number, key: string): void {
  const next = loadDismissed();
  next[String(hostId)] = key;
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
}
