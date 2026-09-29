import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  type LocalEntry,
  localDelete,
  localHomeDir,
  localListDir,
  localListDrives,
  localMkdir,
  localRename,
} from "@/lib/tauri/localfs";
import { winDirname, winJoin } from "@/pages/sftp/model";

/**
 * Owns the Commander's local (left) pane: a Windows filesystem browser. `cwd`
 * is `null` in the drive-list view (reached by going up past a drive root),
 * where `entries` holds one row per drive.
 */
export function useLocalBrowser(visible: boolean) {
  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false); // mkdir / delete / rename in flight
  const started = useRef(false);

  const listDir = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const items = await localListDir(path);
      setEntries(items);
      setCwd(path);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const showDrives = useCallback(async () => {
    setLoading(true);
    try {
      const drives = await localListDrives();
      setEntries(
        drives.map((d) => ({
          name: d,
          path: d,
          kind: "dir" as const,
          size: null,
          mtime: null,
        })),
      );
      setCwd(null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Start at the home directory the first time the pane is shown.
  useEffect(() => {
    if (!visible || started.current) return;
    started.current = true;
    localHomeDir()
      .then((home) => listDir(home))
      .catch((e) => toast.error(errorMessage(e)));
  }, [visible, listDir]);

  const navigate = useCallback((path: string) => void listDir(path), [listDir]);

  const goUp = useCallback(() => {
    if (cwd === null) return; // already at the drive list
    const parent = winDirname(cwd);
    if (parent === null) void showDrives();
    else void listDir(parent);
  }, [cwd, listDir, showDrives]);

  const refresh = useCallback(() => {
    if (cwd === null) void showDrives();
    else void listDir(cwd);
  }, [cwd, listDir, showDrives]);

  const mkdir = useCallback(
    (name: string) => {
      if (cwd === null || !name.trim()) return;
      setBusy(true);
      localMkdir(winJoin(cwd, name.trim()))
        .then(() => {
          toast.success(`Created ${name.trim()}`);
          return listDir(cwd);
        })
        .catch((e) => toast.error(errorMessage(e)))
        .finally(() => setBusy(false));
    },
    [cwd, listDir],
  );

  const remove = useCallback(
    (entry: { path: string; name: string }) => {
      if (cwd === null) return;
      setBusy(true);
      localDelete(entry.path)
        .then(() => {
          toast.success(`Moved ${entry.name} to the Recycle Bin`);
          return listDir(cwd);
        })
        .catch((e) => toast.error(errorMessage(e)))
        .finally(() => setBusy(false));
    },
    [cwd, listDir],
  );

  /**
   * Renames an entry in the folder on show and re-lists it. Resolves with the
   * new path; a failure is thrown back to the caller (the rename dialog), which
   * keeps itself open to show why, rather than toasted here.
   */
  const rename = useCallback(
    async (entry: { path: string; name: string }, newName: string) => {
      if (cwd === null) throw new Error("Open a folder first");
      setBusy(true);
      try {
        const path = await localRename(entry.path, newName);
        toast.success(`Renamed ${entry.name} to ${newName}`);
        await listDir(cwd);
        return path;
      } finally {
        setBusy(false);
      }
    },
    [cwd, listDir],
  );

  return {
    cwd,
    entries,
    loading,
    busy,
    navigate,
    goUp,
    refresh,
    mkdir,
    remove,
    rename,
  };
}
