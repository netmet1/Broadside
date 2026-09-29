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
      return "Existing files are kept; only missing files are copied.";
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

/**
 * How many Commander transfers run at once. Anything past this waits.
 *
 * The cap is not about bandwidth, which is shared however many are in flight,
 * because everything here goes down one SFTP session and that is one SSH
 * channel. It is about round trips: a file is read in 64KB requests, each one
 * waited for, so a single file can never beat 64KB per round trip no matter how
 * fat the link is. Four at once means four requests outstanding instead of one,
 * which is where the difference on a distant host comes from, and why it barely
 * shows on a LAN where the round trip is already nothing.
 *
 * Four rather than more because every extra stream pushes the others further
 * back behind it, and the SFTP client gives up on a request that goes ten
 * seconds unanswered. Four is also what the Broadcast tab allows itself in
 * hosts, so there is one number to remember rather than two.
 */
export const TRANSFER_CONCURRENCY = 4;

// --- Recursive folder-transfer warning thresholds. Above either one, the user
// must confirm the put/get before Broadside executes it. ---
export const WARN_FILES = 100;
export const WARN_BYTES = 100 * 1024 * 1024; // 100 MB

/** True when a folder is big enough to warrant a confirmation before transfer. */
export function isLargeTransfer(files: number, bytes: number): boolean {
  return files > WARN_FILES || bytes > WARN_BYTES;
}

/** What one finished transfer delivered, for the summary toast at the end of a
 *  drop. A single file is `files: 1`, or `skipped: 1` when the clash mode left
 *  the destination alone. */
export type TransferOutcome = {
  name: string;
  isDir: boolean;
  files: number;
  bytes: number;
  skipped: number;
};

/** Why the clash mode left files alone, for a summary where that is all that
 *  happened. The mode's own name goes in brackets, so the fix is findable. */
function skipReason(mode: TransferMode, many: boolean): string {
  return mode === "newer_only"
    ? `${many ? "none is" : "not"} newer than the copy there (Newer only)`
    : `${many ? "all" : "it is"} already there (Skip existing)`;
}

/**
 * The one success toast a drop gets once everything in it has settled.
 *
 * One item keeps the message it always had, naming the file or folder. Several
 * are added up into one line, because a toast per file stacked over the
 * transfer rail and hid the Cancel buttons while the rest were still going.
 * A drop the clash mode skipped entirely says so, and why, rather than
 * reporting an upload of nothing. Null when nothing succeeded: failures and
 * cancels have already said so.
 */
export function transferSummary(
  direction: "put" | "get",
  done: TransferOutcome[],
  mode: TransferMode,
): string | null {
  const verb = direction === "put" ? "Uploaded" : "Downloaded";
  if (done.length === 0) return null;
  const skipped = done.reduce((n, o) => n + o.skipped, 0);
  const files = done.reduce((n, o) => n + o.files, 0);
  const bytes = done.reduce((n, o) => n + o.bytes, 0);
  if (files === 0 && skipped > 0) {
    return skipped === 1 && done.length === 1 && !done[0].isDir
      ? `Skipped ${done[0].name}: ${skipReason(mode, false)}`
      : `Skipped ${skipped} files: ${skipReason(mode, true)}`;
  }
  const skip = skipped > 0 ? `, ${skipped} skipped` : "";
  if (done.length === 1) {
    const o = done[0];
    return o.isDir
      ? `${verb} folder ${o.name} (${o.files} files, ${formatSize(o.bytes)}${skip})`
      : `${verb} ${o.name} (${formatSize(o.bytes)})`;
  }
  if (done.every((o) => !o.isDir)) {
    return `${verb} ${files} files (${formatSize(bytes)}${skip})`;
  }
  return `${verb} ${done.length} items (${files} files, ${formatSize(bytes)}${skip})`;
}

/** The toast for a folder transfer stopped part-way. It says what was kept,
 *  since whole files stay where they landed and only the part-written one (and
 *  any folder left empty) is removed. */
export function folderCancelText(
  direction: "put" | "get",
  name: string,
  stats: { files: number; bytes: number },
): string {
  const what = direction === "put" ? "Upload" : "Download";
  if (stats.files === 0) return `${what} cancelled: ${name}. Nothing was kept.`;
  const n = stats.files === 1 ? "1 finished file" : `${stats.files} finished files`;
  return `${what} cancelled: ${name}. Kept ${n} (${formatSize(stats.bytes)}).`;
}

/**
 * Why a name can't be used, or null when it can. The local side follows
 * Windows' rules, the remote side only POSIX's (a `/` or a NUL). The backend
 * checks the same things; this is here so the rename dialog can say so while
 * the name is being typed instead of after it was sent.
 */
export function nameProblem(side: "local" | "remote", name: string): string | null {
  if (name === "") return "A name can't be empty.";
  if (name === "." || name === "..") return `${name} is not a name a file can have.`;
  if (side === "remote") {
    if (name.includes("/")) return "A name can't contain /.";
    if (name.includes("\0")) return "A name can't contain a NUL character.";
    return null;
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what Windows refuses
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    return 'A name can\'t contain any of \\ / : * ? " < > |';
  }
  if (/[ .]$/.test(name)) return "A name can't end with a space or a dot.";
  if ([...name].length > 255) return "That name is longer than Windows allows.";
  const stem = name.split(".")[0].trimEnd().toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/.test(stem)) {
    return `${stem} is a name Windows keeps for itself.`;
  }
  return null;
}
