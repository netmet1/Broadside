import { invoke } from "@tauri-apps/api/core";

import type { ShellProfile } from "@/lib/localShellProfiles";

/** The editable fields of a profile, as the backend takes them. */
export type ShellProfileInput = Omit<ShellProfile, "id">;

/** Saved local-shell launch profiles, in launcher order. In the database since
 * build 69, so Settings > Reset everything no longer takes them and a backup
 * carries them. */
export function listShellProfiles(): Promise<ShellProfile[]> {
  return invoke<ShellProfile[]>("list_shell_profiles");
}

/** Create a profile under `id` (a uuid). `after` puts it directly below that
 * profile, the way Duplicate places a copy; without it, it goes at the end. */
export function createShellProfile(
  id: string,
  input: ShellProfileInput,
  after?: string,
): Promise<ShellProfile> {
  return invoke<ShellProfile>("create_shell_profile", {
    id,
    input,
    after: after ?? null,
  });
}

export function updateShellProfile(
  id: string,
  input: ShellProfileInput,
): Promise<ShellProfile> {
  return invoke<ShellProfile>("update_shell_profile", { id, input });
}

export function deleteShellProfile(id: string): Promise<number> {
  return invoke<number>("delete_shell_profile", { id });
}

/** Save the launcher order: these ids first, in this order. */
export function reorderShellProfiles(ids: string[]): Promise<void> {
  return invoke<void>("reorder_shell_profiles", { ids });
}

export type LegacyImport = { imported: number; skipped: number };

/** The one-time copy of the profiles localStorage held before build 69. Only
 * the first call on a database does anything. */
export function importLegacyShellProfiles(
  profiles: ShellProfile[],
): Promise<LegacyImport> {
  return invoke<LegacyImport>("import_legacy_shell_profiles", { profiles });
}

/** Write profiles to `path`. Resolves to how many were written. `ids` writes
 * just those (one profile, or the ones ticked on the Hosts tab); without it,
 * every profile. The file is the same shape either way, so a one-profile export
 * imports like any other. */
export function exportShellProfiles(
  path: string,
  ids?: string[],
): Promise<number> {
  return invoke<number>("export_shell_profiles", { path, ids: ids ?? null });
}

/** Read a profile export for the import preview. Saves nothing. Rejects a file
 * that isn't one, or that holds a profile the form could not have made. */
export function readShellProfileFile(path: string): Promise<ShellProfileInput[]> {
  return invoke<ShellProfileInput[]>("read_shell_profile_file", { path });
}

/** Save the profiles confirmed in the import preview, after the existing ones.
 * All or nothing. */
export function importShellProfiles(profiles: ShellProfile[]): Promise<number> {
  return invoke<number>("import_shell_profiles", { profiles });
}
