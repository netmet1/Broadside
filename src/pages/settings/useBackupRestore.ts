import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import { backupAppData, restoreAppData } from "@/lib/tauri/settings";
import { queueToastAfterReload } from "@/lib/toastsAfterReload";

/** Backup & Restore section state + handlers. `backupIncludeCsv`/`runBackup`
 * are also consumed by the Danger Zone dialog's "back up first" offer, so the
 * checkbox stays in sync across both surfaces. */
export function useBackupRestore() {
  const [backupIncludeCsv, setBackupIncludeCsv] = useState(true);
  const [backingUp, setBackingUp] = useState(false);

  // Restore: picking a backup file opens a confirmation (it overwrites all
  // current data); confirming runs the restore and reloads the app.
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoreFileName = restorePath?.split(/[\\/]/).pop() ?? null;

  const runBackup = async () => {
    try {
      const dir = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a backup folder",
      });
      if (typeof dir !== "string") return;
      setBackingUp(true);
      const report = await backupAppData(dir, backupIncludeCsv);
      toast.success(
        report.csv_path
          ? `Backed up database (${report.host_count} hosts) + hosts CSV`
          : `Backed up database (${report.host_count} hosts)`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBackingUp(false);
    }
  };

  // Restore step 1: pick a backup .db file, then open the confirm dialog.
  const pickRestoreFile = async () => {
    try {
      const path = await openDialog({
        directory: false,
        multiple: false,
        title: "Choose a Broadside backup (.db)",
        filters: [{ name: "Broadside backup", extensions: ["db"] }],
      });
      if (typeof path !== "string") return;
      setRestorePath(path);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Restore step 2: overwrite the live database with the chosen snapshot, then
  // reload so every page re-reads the restored data from the (persistent) Rust
  // connection. Credentials aren't in a backup, so restored hosts re-prompt.
  const runRestore = async () => {
    if (!restorePath) return;
    setRestoring(true);
    try {
      const report = await restoreAppData(restorePath);
      const restored = `Restored ${report.host_count} ${
        report.host_count === 1 ? "host" : "hosts"
      }`;
      toast.success(`${restored}, reloading…`);
      // The reload is 700 ms away, far too soon to read anything, so what the
      // restore has to say is said again on the page that comes back.
      queueToastAfterReload("success", `${restored} from ${restoreFileName}`);
      // Said separately, and as a warning rather than folded into the success
      // line, because both are things the operator now has to do something
      // about: an entry to re-add, or a host that will ask about its key on the
      // next connect. Silence here would read as "everything came back".
      if (
        report.dropped_terminals > 0 ||
        report.cleared_host_keys > 0 ||
        report.cleared_startup_commands > 0 ||
        report.orphaned_custom_profiles > 0 ||
        report.sudo_autofill_disabled
      ) {
        const parts: string[] = [];
        if (report.dropped_terminals > 0) {
          parts.push(
            `${report.dropped_terminals} custom local shell${
              report.dropped_terminals === 1 ? "" : "s"
            } not restored (re-add under Settings)`,
          );
        }
        if (report.cleared_startup_commands > 0) {
          parts.push(
            `${report.cleared_startup_commands} shell profile startup command${
              report.cleared_startup_commands === 1 ? "" : "s"
            } emptied (type them again in the + launcher)`,
          );
        }
        if (report.orphaned_custom_profiles > 0) {
          parts.push(
            `${report.orphaned_custom_profiles} profile${
              report.orphaned_custom_profiles === 1 ? "" : "s"
            } used a custom local shell and now point at none (re-add the shell, then pick it again in Edit)`,
          );
        }
        if (report.cleared_host_keys > 0) {
          parts.push(
            `${report.cleared_host_keys} trusted host key${
              report.cleared_host_keys === 1 ? "" : "s"
            } cleared (each host will ask again)`,
          );
        }
        if (report.sudo_autofill_disabled) {
          parts.push("sudo auto-fill turned off (Settings > Security)");
        }
        // Only after the reload: shown now, it would be torn down mid-read.
        // It stays until closed, since each part is something to go and do.
        queueToastAfterReload("warning", parts.join("; "));
      }
      setRestorePath(null);
      setTimeout(() => window.location.reload(), 700);
    } catch (e) {
      toast.error(errorMessage(e));
      setRestoring(false);
    }
  };

  return {
    backupIncludeCsv,
    setBackupIncludeCsv,
    backingUp,
    runBackup,
    restorePath,
    setRestorePath,
    restoring,
    restoreFileName,
    pickRestoreFile,
    runRestore,
  };
}
