import { useCallback, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import type { ProfileImportRow } from "@/components/ShellProfileImportDialog";
import {
  copyLabel,
  importLabels,
  type ShellProfile,
} from "@/lib/localShellProfiles";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  createShellProfile,
  deleteShellProfile,
  exportShellProfiles,
  importShellProfiles,
  readShellProfileFile,
  reorderShellProfiles,
  updateShellProfile,
} from "@/lib/tauri/shellProfiles";
import { loadShellProfiles, useShellProfiles } from "@/lib/useShellProfiles";

const FILE_FILTER = [{ name: "Broadside shell profiles", extensions: ["json"] }];

function plural(n: number): string {
  return `${n} profile${n === 1 ? "" : "s"}`;
}

/**
 * Everything the Terminals launcher does to saved profiles: save, delete,
 * duplicate, reorder, export and import. Each one is a database write followed
 * by a fresh read, so the list on screen is always what is stored.
 *
 * Split out of TerminalsPage, which is large enough already, and because none
 * of it is about terminals.
 */
export function useProfileActions(visible: boolean) {
  const { profiles: loaded, setProfiles, refresh } = useShellProfiles(visible);
  const profiles = useMemo(() => loaded ?? [], [loaded]);

  /** Run a write, say what went wrong if it did, and re-read either way. */
  const write = useCallback(
    async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  /** Insert or replace, decided by whether the id is already stored. */
  const saveProfile = useCallback(
    (profile: ShellProfile) => {
      const { id, ...input } = profile;
      const exists = profiles.some((p) => p.id === id);
      void write(() =>
        exists ? updateShellProfile(id, input) : createShellProfile(id, input),
      );
    },
    [profiles, write],
  );

  const deleteProfile = useCallback(
    (id: string) => void write(() => deleteShellProfile(id)),
    [write],
  );

  /** Copy a profile, named so the two can be told apart, sitting directly
   * under the one it came from. The whole point is the profiles that differ by
   * one field: the same pwsh in a different folder, the same folder running a
   * different command. Building the second from scratch is retyping the first. */
  const duplicateProfile = useCallback(
    (source: ShellProfile) => {
      const { id, ...input } = source;
      const label = copyLabel(profiles, source.label);
      void write(async () => {
        await createShellProfile(crypto.randomUUID(), { ...input, label }, id);
        toast.success(`Duplicated as "${label}"`);
      });
    },
    [profiles, write],
  );

  /** The list after a drag. Shown at once and saved behind it; a failed save
   * says so and puts the stored order back. */
  const reorderProfiles = useCallback(
    (ids: string[]) => {
      setProfiles((prev) => {
        if (!prev) return prev;
        const byId = new Map(prev.map((p) => [p.id, p] as const));
        const moved = ids.flatMap((id) => byId.get(id) ?? []);
        return [...moved, ...prev.filter((p) => !ids.includes(p.id))];
      });
      reorderShellProfiles(ids).catch((e: unknown) => {
        toast.error(errorMessage(e));
        void refresh();
      });
    },
    [setProfiles, refresh],
  );

  const exportProfiles = useCallback(async () => {
    try {
      const path = await saveDialog({
        title: "Export shell profiles",
        defaultPath: "broadside-shell-profiles.json",
        filters: FILE_FILTER,
      });
      if (typeof path !== "string") return;
      const n = await exportShellProfiles(path);
      toast.success(`Exported ${plural(n)}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  /** The profiles read from a file, waiting in the preview. Null when no
   * import is in progress. */
  const [importRows, setImportRows] = useState<ProfileImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);

  /** Pick a file and read it into the preview. Nothing is saved here. */
  const startImport = useCallback(async () => {
    try {
      const path = await openDialog({
        title: "Import shell profiles",
        multiple: false,
        filters: FILE_FILTER,
      });
      if (typeof path !== "string") return;
      const rows = await readShellProfileFile(path);
      if (rows.length === 0) {
        toast("That file holds no profiles.");
        return;
      }
      // Names are checked against what is stored now, not the list on screen,
      // which may be a read behind.
      const current = await loadShellProfiles();
      const names = importLabels(
        current,
        rows.map((r) => r.label),
      );
      setImportRows(
        rows.map((r, i) => ({ ...r, label: names[i]!, originalLabel: r.label })),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  const cancelImport = useCallback(() => setImportRows(null), []);

  const confirmImport = useCallback(async () => {
    if (!importRows) return;
    setImporting(true);
    try {
      const n = await importShellProfiles(
        importRows.map((r) => ({
          id: crypto.randomUUID(),
          label: r.label,
          shellId: r.shellId,
          cwd: r.cwd,
          startupCommand: r.startupCommand,
          color: r.color,
        })),
      );
      toast.success(`Imported ${plural(n)}`);
      setImportRows(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setImporting(false);
      await refresh();
    }
  }, [importRows, refresh]);

  return {
    profiles,
    loading: loaded === null,
    saveProfile,
    deleteProfile,
    duplicateProfile,
    reorderProfiles,
    exportProfiles,
    importRows,
    importing,
    startImport,
    cancelImport,
    confirmImport,
  };
}
