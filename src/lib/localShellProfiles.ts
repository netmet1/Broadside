/** Saved local-shell launch profiles: a named shell + a working directory +
 * an optional startup command, so an advanced user can open a shell configured
 * exactly how they want it (e.g. "Broadside dev" = pwsh in the project folder,
 * running `claude`). Launched from the Terminals "+" launcher and created,
 * edited, reordered, exported and imported there. Never holds credentials.
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
