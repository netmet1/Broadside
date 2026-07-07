import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { PresentedKey } from "@/lib/tauri/ssh";

/** One remote directory entry. `kind` distinguishes folders from files. */
export type SftpEntry = {
  name: string;
  /** Absolute remote path (POSIX, forward slashes). */
  path: string;
  kind: "dir" | "file" | "symlink";
  size: number | null;
  /** Modification time, epoch seconds (null when the server omits it). */
  mtime: number | null;
  permissions: number | null;
};

/** Outcome of opening a session — mirrors the connection-test `ProbeResult`. */
export type SftpConnectResult =
  | { status: "ok"; session_id: string; cwd: string }
  | { status: "unknown_key"; key: PresentedKey }
  | {
      status: "key_mismatch";
      stored_fingerprint: string;
      presented: PresentedKey;
    }
  | { status: "auth_failed"; message: string }
  | { status: "unreachable"; message: string }
  | { status: "no_credentials" };

/** Opens (or re-opens) an SFTP session to a host under a caller-chosen id. */
export function sftpConnect(
  hostId: number,
  sessionId: string,
): Promise<SftpConnectResult> {
  return invoke<SftpConnectResult>("sftp_connect", { hostId, sessionId });
}

export function sftpList(
  sessionId: string,
  path: string,
): Promise<SftpEntry[]> {
  return invoke<SftpEntry[]>("sftp_list", { sessionId, path });
}

export function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke<void>("sftp_mkdir", { sessionId, path });
}

/** Creates a remote directory and any missing ancestors (like `mkdir -p`). */
export function sftpEnsureRemoteDir(
  sessionId: string,
  path: string,
): Promise<void> {
  return invoke<void>("sftp_ensure_remote_dir", { sessionId, path });
}

export function sftpDelete(
  sessionId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  return invoke<void>("sftp_delete", { sessionId, path, isDir });
}

/** Uploads a local file to a remote path; resolves with bytes transferred.
 *  When `transferId` is given, emits `sftp:transfer_progress` (keyed by it) as
 *  the file streams, for a live byte progress bar. */
export function sftpUpload(args: {
  hostId: number;
  sessionId: string;
  localPath: string;
  remotePath: string;
  transferId?: string;
}): Promise<number> {
  return invoke<number>("sftp_upload", {
    hostId: args.hostId,
    sessionId: args.sessionId,
    localPath: args.localPath,
    remotePath: args.remotePath,
    transferId: args.transferId ?? null,
  });
}

/** Downloads a remote file to a local path; resolves with bytes transferred.
 *  When `transferId` is given, emits `sftp:transfer_progress` (keyed by it) as
 *  the file streams, for a live byte progress bar. */
export function sftpDownload(args: {
  hostId: number;
  sessionId: string;
  remotePath: string;
  localPath: string;
  transferId?: string;
}): Promise<number> {
  return invoke<number>("sftp_download", {
    hostId: args.hostId,
    sessionId: args.sessionId,
    remotePath: args.remotePath,
    localPath: args.localPath,
    transferId: args.transferId ?? null,
  });
}

export function sftpDisconnect(sessionId: string): Promise<void> {
  return invoke<void>("sftp_disconnect", { sessionId });
}

/** Signals the session's in-flight recursive transfer to stop at the next file. */
export function sftpCancelTransfer(sessionId: string): Promise<void> {
  return invoke<void>("sftp_cancel_transfer", { sessionId });
}

/** File count + total bytes for a directory (scan result / transfer result).
 *  `files`/`bytes` are what actually transferred; `skipped` is files left by the
 *  clash mode; `cancelled` is true when it stopped early at the user's request. */
export type TransferStats = {
  files: number;
  bytes: number;
  skipped: number;
  cancelled: boolean;
};

/** What a folder transfer does when a file already exists at the destination. */
export type TransferMode = "overwrite_all" | "newer_only" | "skip_existing";

/** Recursively counts files + bytes under a remote directory (pre-flight). */
export function sftpScanDir(
  sessionId: string,
  path: string,
): Promise<TransferStats> {
  return invoke<TransferStats>("sftp_scan_dir", { sessionId, path });
}

/** Recursively uploads a local directory; resolves with the transfer stats.
 *  Emits `sftp:transfer_progress` events keyed by `transferId` as it runs. */
export function sftpUploadDir(args: {
  hostId: number;
  sessionId: string;
  localPath: string;
  remotePath: string;
  transferId: string;
  mode: TransferMode;
}): Promise<TransferStats> {
  return invoke<TransferStats>("sftp_upload_dir", {
    hostId: args.hostId,
    sessionId: args.sessionId,
    localPath: args.localPath,
    remotePath: args.remotePath,
    transferId: args.transferId,
    mode: args.mode,
  });
}

/** Recursively downloads a remote directory; resolves with the transfer stats.
 *  Emits `sftp:transfer_progress` events keyed by `transferId` as it runs. */
export function sftpDownloadDir(args: {
  hostId: number;
  sessionId: string;
  remotePath: string;
  localPath: string;
  transferId: string;
  mode: TransferMode;
}): Promise<TransferStats> {
  return invoke<TransferStats>("sftp_download_dir", {
    hostId: args.hostId,
    sessionId: args.sessionId,
    remotePath: args.remotePath,
    localPath: args.localPath,
    transferId: args.transferId,
    mode: args.mode,
  });
}

/** Running counts for a folder transfer (matched to a call by `transfer_id`). */
export type TransferProgressEvent = {
  transfer_id: string;
  files_done: number;
  bytes_done: number;
};

export function onSftpTransferProgress(
  handler: (e: TransferProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgressEvent>("sftp:transfer_progress", (ev) =>
    handler(ev.payload),
  );
}
