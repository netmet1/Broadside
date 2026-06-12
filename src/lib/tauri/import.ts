import { invoke } from "@tauri-apps/api/core";

export type RowStatus = "ready" | "duplicate" | "error";

export type RowPreview = {
  row_number: number;
  label: string;
  hostname: string;
  port: number;
  username: string;
  /** Hex color, or the literal "#auto" for app-side palette picking. */
  color: string;
  linux_flavor: string | null;
  notes: string | null;
  status: RowStatus;
  message: string | null;
};

export type ImportHostInput = {
  label: string;
  hostname: string;
  port: number;
  username: string;
  color: string;
  linux_flavor: string | null;
  notes: string | null;
};

export type SkippedRow = { label: string; reason: string };

export type ImportOutcome = {
  imported: number;
  skipped: SkippedRow[];
};

export function previewImport(path: string): Promise<RowPreview[]> {
  return invoke<RowPreview[]>("preview_import", { path });
}

export function importHosts(rows: ImportHostInput[]): Promise<ImportOutcome> {
  return invoke<ImportOutcome>("import_hosts", { rows });
}
