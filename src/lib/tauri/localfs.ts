import { invoke } from "@tauri-apps/api/core";

import type { TransferStats } from "@/lib/tauri/sftp";

/** One local directory entry — same shape as the remote `SftpEntry` so both
 *  Commander panes render identically. */
export type LocalEntry = {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number | null;
  mtime: number | null;
};

export function localHomeDir(): Promise<string> {
  return invoke<string>("local_home_dir");
}

export function localListDir(path: string): Promise<LocalEntry[]> {
  return invoke<LocalEntry[]>("local_list_dir", { path });
}

export function localListDrives(): Promise<string[]> {
  return invoke<string[]>("local_list_drives");
}

export function localMkdir(path: string): Promise<void> {
  return invoke<void>("local_mkdir", { path });
}

/** Moves a local file/folder to the Recycle Bin (recoverable). */
export function localDelete(path: string): Promise<void> {
  return invoke<void>("local_delete", { path });
}

/** Recursively counts files + bytes under a local directory (pre-flight). */
export function localScanDir(path: string): Promise<TransferStats> {
  return invoke<TransferStats>("local_scan_dir", { path });
}
