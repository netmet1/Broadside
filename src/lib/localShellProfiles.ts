/** Saved local-shell launch profiles: a named shell + a working directory +
 * an optional startup command, so an advanced user can open a shell configured
 * exactly how they want it (e.g. "Broadside dev" = pwsh in the project folder,
 * running `claude`). A UI pref in localStorage, alongside the disabled-shells
 * list in {@link ./localShellPrefs}. Profiles are launched from the Terminals
 * "+" launcher and created/edited inline there. Never holds credentials. */

const KEY = "local-shell-profiles";

export type ShellProfile = {
  /** Stable id (uuid), the React key and the edit/delete handle. */
  id: string;
  /** Display name, also used as the tab label so a profile tab is
   * distinguishable from a plain shell tab. */
  label: string;
  /** Which detected shell to launch: `powershell` | `pwsh` | `cmd` |
   * `wsl:<distro>`. May reference a shell that isn't currently detected (a WSL
   * distro that was removed); the launcher flags such a profile rather than
   * dropping it. */
  shellId: string;
  /** Directory to start the shell in. Empty means "the shell's default"
   * (USERPROFILE), same as opening the raw shell. */
  cwd: string;
  /** Optional command run once the shell opens (typed into it, as if the user
   * had). Empty means none. */
  startupCommand: string;
};

/** Parse the stored list, tolerating a missing/old/corrupt value by returning
 * an empty list rather than throwing (a bad blob shouldn't kill the launcher). */
export function loadProfiles(): ShellProfile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
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
      }))
      .filter((p) => p.label && p.shellId);
  } catch {
    return [];
  }
}

export function saveProfiles(profiles: ShellProfile[]): void {
  localStorage.setItem(KEY, JSON.stringify(profiles));
}

/** Insert (new id) or replace (matching id) a profile, returning the new list.
 * Pure — the caller persists and sets state with the result. */
export function upsertProfile(
  profiles: ShellProfile[],
  profile: ShellProfile,
): ShellProfile[] {
  const idx = profiles.findIndex((p) => p.id === profile.id);
  if (idx === -1) return [...profiles, profile];
  const next = profiles.slice();
  next[idx] = profile;
  return next;
}

export function removeProfile(
  profiles: ShellProfile[],
  id: string,
): ShellProfile[] {
  return profiles.filter((p) => p.id !== id);
}
