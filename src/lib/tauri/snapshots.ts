import { invoke } from "@tauri-apps/api/core";

import type { TemplateItem, TemplateLayout } from "@/lib/tauri/templates";

/**
 * Workspace snapshots: every open workspace saved under one name, opened again
 * as a set. The TS mirror of `src-tauri/src/db/snapshots.rs`.
 */

export type SnapshotWorkspace = {
  name: string;
  /** `#rrggbb`, or empty for none. */
  color: string;
  named: boolean;
  layout: TemplateLayout | null;
  items: TemplateItem[];
};

export type Snapshot = {
  id: number;
  name: string;
  /** Which workspace was on screen, an index into `workspaces`. */
  active: number;
  workspaces: SnapshotWorkspace[];
  created_at: string;
  updated_at: string;
};

export type SnapshotInput = {
  name: string;
  active: number;
  workspaces: SnapshotWorkspace[];
};

export function listSnapshots(): Promise<Snapshot[]> {
  return invoke<Snapshot[]>("list_snapshots");
}

export function createSnapshot(input: SnapshotInput): Promise<Snapshot> {
  return invoke<Snapshot>("create_snapshot", { input });
}

/** Take the snapshot again: its contents replaced with `input`'s. */
export function updateSnapshot(id: number, input: SnapshotInput): Promise<Snapshot> {
  return invoke<Snapshot>("update_snapshot", { id, input });
}

export function renameSnapshot(id: number, name: string): Promise<Snapshot> {
  return invoke<Snapshot>("rename_snapshot", { id, name });
}

export function deleteSnapshot(id: number): Promise<number> {
  return invoke<number>("delete_snapshot", { id });
}
