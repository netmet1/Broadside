import { invoke } from "@tauri-apps/api/core";

export type LocalProbe = {
  cpu_cores: number;
  total_memory_mb: number;
  available_memory_mb: number;
  suggested_max_sessions: number;
  probed_at: string;
};

export type HostLatency = {
  host_id: number;
  label: string;
  /** TCP connect round-trip in milliseconds, or null when unreachable. */
  connect_ms: number | null;
};

export type CoreRuleInfo = {
  id: string;
  description: string;
  help_tip: string;
};

/** A user-added guard rule (D-014 structured form — no raw regex). */
export type UserRule = {
  id: string;
  description: string;
  commands: string[];
  required_flags: string[];
  path_patterns: string[];
  arg_all_of: string[];
  help_tip: string | null;
  enabled: boolean;
};

/** A user-defined shortcut command (D-054). */
export type ShortcutCommand = {
  id: string;
  command: string;
};

export type AppSettings = {
  local_probe: LocalProbe | null;
  /** null = follow the probe suggestion. */
  max_concurrent_sessions: number | null;
  default_timeout_secs: number;
  help_hints_enabled: boolean;
  core_rules: CoreRuleInfo[];
  user_rules: UserRule[];
  core_shortcuts: string[];
  user_shortcuts: ShortcutCommand[];
  terminal_font_family: string;
  terminal_font_size: number;
  app_font_size: number;
};

/** A host a command targeted (D-061 sub-4). `id` resolves the live colour;
 * `label` is the snapshot fallback. `id` is null for sources without it. */
export type HistoryHost = { id: number | null; label: string };

export type HistoryEntry = {
  id: number;
  command: string;
  host_count: number;
  ts: string;
  hosts: HistoryHost[];
  source: string | null;
};

export function getAppSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("get_app_settings");
}

export function setAppSettings(input: {
  max_concurrent_sessions: number | null;
  default_timeout_secs: number;
}): Promise<void> {
  return invoke<void>("set_app_settings", { input });
}

export function setHelpHintsEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_help_hints_enabled", { enabled });
}

/** Resets app preferences (timeouts, sessions, fonts, hints) to defaults.
 * Does not touch hosts, credentials, guard rules, shortcuts or history. The
 * caller also clears its own localStorage UI prefs and reloads. */
export function resetAppSettings(): Promise<void> {
  return invoke<void>("reset_app_settings");
}

export type UiSettingsInput = {
  terminal_font_family: string;
  terminal_font_size: number;
  app_font_size: number;
};

export function setUiSettings(input: UiSettingsInput): Promise<void> {
  return invoke<void>("set_ui_settings", { input });
}

export function saveShortcuts(shortcuts: ShortcutCommand[]): Promise<void> {
  return invoke<void>("save_shortcuts", { shortcuts });
}

export function saveGuardRules(rules: UserRule[]): Promise<void> {
  return invoke<void>("save_guard_rules", { rules });
}

export function recalibrateProbe(): Promise<LocalProbe> {
  return invoke<LocalProbe>("recalibrate_probe");
}

export function networkProbe(): Promise<HostLatency[]> {
  return invoke<HostLatency[]>("network_probe");
}

export function commandHistory(limit: number): Promise<HistoryEntry[]> {
  return invoke<HistoryEntry[]>("command_history", { limit });
}

export function clearCommandHistory(): Promise<number> {
  return invoke<number>("clear_command_history");
}

export type BackupReport = {
  db_path: string;
  csv_path: string | null;
  host_count: number;
};

/** Snapshots the database (hosts, settings, host keys, history) into `dir`,
 * optionally alongside a re-importable hosts CSV. Credentials are never
 * included (they live in the OS credential store, D-008). */
export function backupAppData(
  dir: string,
  includeHostsCsv: boolean,
): Promise<BackupReport> {
  return invoke<BackupReport>("backup_app_data", { dir, includeHostsCsv });
}
