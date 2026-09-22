/** Saved local-shell launch profiles: a named shell + a working directory +
 * an optional startup command, so an advanced user can open a shell configured
 * exactly how they want it (e.g. "Broadside dev" = pwsh in the project folder,
 * running `claude`). Launched and reordered from the Terminals "+" launcher,
 * and listed, launched, created, edited, exported and imported on the Hosts
 * tab's Profiles side. Never holds credentials.
 *
 * Stored in the database since build 69 (see `lib/tauri/shellProfiles` and
 * `src-tauri/src/db/shell_profiles.rs`). They used to live in localStorage as a
 * UI pref, and Settings > Reset everything, which clears localStorage, deleted
 * them all. This file keeps the type, the pure naming helpers, and the reader
 * for that old localStorage value, which the one-time copy uses. */

/** Where build 68 and earlier kept profiles. Read once, to copy them into the
 * database, and never written or deleted: it is a second copy for anyone who
 * upgrades and finds something wrong. */
const LEGACY_KEY = "local-shell-profiles";

/** The shell id a profile carries when it points at no shell at all: a custom
 * local shell that an import could not match, or that a restore deleted (see
 * `db/shell_profiles.rs`). Custom ids start at 1, so this names no real shell,
 * and the launcher strikes such a profile through. */
export const UNMATCHED_CUSTOM = "custom:none";

export type ShellProfile = {
  /** Stable id (uuid), the React key and the edit/delete handle. Saved
   * templates name a profile by it, so it never changes. */
  id: string;
  /** Display name, also used as the tab label so a profile tab is
   * distinguishable from a plain shell tab. */
  label: string;
  /** Which shell to launch: `powershell` | `pwsh` | `cmd` | `wsl:<distro>` |
   * `custom:<id>`. May reference a shell that isn't currently available (a WSL
   * distro that was removed); the launcher flags such a profile rather than
   * dropping it. */
  shellId: string;
  /** Directory to start the shell in. Empty means "the shell's default"
   * (USERPROFILE), same as opening the raw shell. */
  cwd: string;
  /** Optional command run once the shell opens (typed into it, as if the user
   * had). Empty means none. */
  startupCommand: string;
  /** The name of the custom local shell this profile is asking for, and empty
   * unless {@link shellId} is {@link UNMATCHED_CUSTOM}. A restore deletes every
   * custom local shell and re-points the profiles that used one, keeping the
   * name here so the launcher and the edit form can say which shell to add back
   * rather than leaving you to work it out from the profile's own name. An
   * import that could not match a name keeps it the same way.
   *
   * Read, shown and carried back through a save. Nothing launches from it: a
   * profile opens a program only once you have added that shell under Settings
   * and picked it in Edit. */
  wantedShell: string;
  /** Tab colour, `#rrggbb`. Empty means "follow the shell's own colour", which
   * is what every profile saved before this field existed does.
   *
   * A profile overrides its shell's colour because a profile is a purpose
   * rather than a language: "prod tunnel" and "Broadside dev" are the same kind
   * of thing a host is, and want telling apart the same way, even when both of
   * them are pwsh. See {@link ./terminalColors}. */
  color: string;
};

/** The profiles build 68 and earlier saved in localStorage, tolerating a
 * missing/old/corrupt value by returning an empty list rather than throwing. */
export function readLegacyProfiles(): ShellProfile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        id: typeof p.id === "string" ? p.id : crypto.randomUUID(),
        label: typeof p.label === "string" ? p.label : "",
        shellId: typeof p.shellId === "string" ? p.shellId : "",
        cwd: typeof p.cwd === "string" ? p.cwd : "",
        startupCommand:
          typeof p.startupCommand === "string" ? p.startupCommand : "",
        // Nothing in localStorage ever had one: the column arrived with the
        // restore that writes it.
        wantedShell: "",
        // Absent (saved before colours existed) or malformed both mean "follow
        // the shell", which is exactly what those profiles did.
        color:
          typeof p.color === "string" && /^#[0-9a-fA-F]{6}$/.test(p.color)
            ? p.color
            : "",
      }))
      .filter((p) => p.label && p.shellId);
  } catch {
    return [];
  }
}

/** This machine's custom local shell of that name, if it has one. Ids are per
 * machine and a restore empties the table, so a name is the only thing that can
 * match a profile to the shell it used to open. Compared trimmed and
 * case-insensitively, the way an import matches one (`db/shell_profiles.rs`).
 *
 * Takes the launchable shells rather than the custom terminals, so a shell
 * hidden in Settings is not offered as a match it cannot honour. */
export function matchingCustomShell<T extends { id: string; label: string }>(
  shells: T[],
  wanted: string,
): T | undefined {
  const name = wanted.trim().toLowerCase();
  if (!name) return undefined;
  return shells.find(
    (s) => s.id.startsWith("custom:") && s.label.trim().toLowerCase() === name,
  );
}

/**
 * Why a profile will not launch, as one sentence that names it.
 *
 * One wording in one place, because four places have to say it: the "+"
 * launcher's toast, a launch from the Hosts tab, the Profiles table's amber
 * cell, and the skipped list a template launch reports. They had drifted into
 * three slightly different sentences already.
 *
 * `advise` appends what to do about it, and only the custom-shell case gets it:
 * a WSL distro that has been uninstalled is not something Settings can add
 * back, so there would be nothing useful to append.
 */
export function missingShellNote(p: ShellProfile, advise = false): string {
  const wanted = p.shellId === UNMATCHED_CUSTOM ? p.wantedShell : "";
  if (!wanted) {
    return `"${p.label}" uses a shell that isn't available on this machine.`;
  }
  const note = `"${p.label}" opened the custom local shell "${wanted}", which isn't on this machine.`;
  return advise
    ? `${note} Add it under Settings > Local shells, then pick it in Edit.`
    : note;
}

/** Strips one trailing ` (copy)` or ` (copy N)` off a label, so a copy of a
 * copy counts from the original rather than stacking suffixes. `Foo (copy 3)`
 * gives `Foo`; `Foo` gives `Foo`. Only the last one goes, so a profile the user
 * deliberately called `Backup (copy) (copy)` still has a base of
 * `Backup (copy)` and numbers from there. */
function copyBase(label: string): string {
  return label.replace(/\s*\((?:copy)(?:\s+\d+)?\)$/i, "").trim() || label;
}

/** Compared case-insensitively and on the trimmed name, because two profiles
 * differing only in case are two profiles nobody can tell apart in a menu. */
function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

function copyLabelAmong(taken: Set<string>, label: string): string {
  const stem = copyBase(label);
  const base = `${stem} (copy)`;
  if (!taken.has(labelKey(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (copy ${n})`;
    if (!taken.has(labelKey(candidate))) return candidate;
  }
}

/** A name for a copy of `label` that is not already taken: `X (copy)`, then
 * `X (copy 2)`, `X (copy 3)`. Duplicating the same profile three times should
 * give three profiles you can tell apart, not three called the same thing.
 *
 * Duplicating a *copy* collapses rather than nests: a copy of `X (copy)` is
 * `X (copy 2)`, not `X (copy) (copy)`. The suffix is bookkeeping, and a name
 * that grows a word every time you press the button stops being readable at
 * exactly the point a long list needs it most. */
export function copyLabel(profiles: ShellProfile[], label: string): string {
  return copyLabelAmong(new Set(profiles.map((p) => labelKey(p.label))), label);
}

/** The names imported profiles will be saved under. A name already in use,
 * here or earlier in the same file, gets the same `(copy)` numbering Duplicate
 * uses: never skipped, and never written over the profile that has it, since an
 * import that replaced a profile would be a second way to lose one. */
export function importLabels(existing: ShellProfile[], incoming: string[]): string[] {
  const taken = new Set(existing.map((p) => labelKey(p.label)));
  return incoming.map((label) => {
    const name = taken.has(labelKey(label)) ? copyLabelAmong(taken, label) : label.trim();
    taken.add(labelKey(name));
    return name;
  });
}
