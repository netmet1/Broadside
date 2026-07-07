//! Pure helpers for the SFTP browser: POSIX remote-path math + formatting.
//! Remote paths are always forward-slash even though the app runs on Windows,
//! so we never touch Node/`path` semantics here.

import type { TransferMode } from "@/lib/tauri/sftp";

/** localStorage key for the shared "When a file already exists" clash mode.
 *  Persists across restarts and is shared by both SFTP tabs. */
export const MODE_KEY = "sftp-transfer-mode";

/** Reads the persisted clash mode, defaulting to "overwrite_all". */
export function readTransferMode(): TransferMode {
  const saved = localStorage.getItem(MODE_KEY);
  return saved === "newer_only" || saved === "skip_existing"
    ? saved
    : "overwrite_all";
}

/** Human-readable description of what a clash mode does (for confirm dialogs). */
export function clashText(mode: TransferMode): string {
  switch (mode) {
    case "newer_only":
      return "Existing files are overwritten only when the source is newer.";
    case "skip_existing":
      return "Existing files are kept — only missing files are copied.";
    default:
      return "Existing files with the same names are overwritten.";
  }
}

/** Parent directory of a POSIX path (root stays root). */
export function posixDirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "" ) return "/";
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

/** Joins a directory and a child name with a single `/`. */
export function posixJoin(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Last path segment (used to derive a remote name from a local file path,
 *  which on Windows may use either separator). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Human-readable byte size (e.g. `1.4 MB`). Empty string for unknown. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Epoch seconds → local `YYYY-MM-DD HH:MM`, or "" when absent/invalid. */
export function formatMtime(mtime: number | null): string {
  if (mtime === null) return "";
  const d = new Date(mtime * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/** True when a failed op means the backend session is gone (dropped/restarted),
 *  so the UI should reset to the disconnected state and prompt a reconnect. */
export function isSessionGone(message: string): boolean {
  return message.includes("no such sftp session");
}

// --- Local (Windows) path helpers for the Commander's left pane. Local paths
// use backslashes; navigating up past a drive root yields the drive list. ---

/** Parent of a local path, or `null` at a drive root (→ show the drive list). */
export function winDirname(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  // "C:" (a bare drive) → up means the drive list.
  if (/^[A-Za-z]:$/.test(trimmed)) return null;
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  // Normalise a bare-drive parent ("C:") back to its root ("C:\").
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent === "" ? null : parent;
}

/** Joins a local directory and a child name with a single backslash. */
export function winJoin(dir: string, name: string): string {
  return dir.endsWith("\\") || dir.endsWith("/") ? `${dir}${name}` : `${dir}\\${name}`;
}

// --- Recursive folder-transfer warning thresholds. Above either one, the user
// must confirm the put/get before Broadside executes it. ---
export const WARN_FILES = 100;
export const WARN_BYTES = 100 * 1024 * 1024; // 100 MB

/** True when a folder is big enough to warrant a confirmation before transfer. */
export function isLargeTransfer(files: number, bytes: number): boolean {
  return files > WARN_FILES || bytes > WARN_BYTES;
}
