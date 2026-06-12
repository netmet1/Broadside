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
};

/** A user-added guard rule (D-014 structured form — no raw regex). */
export type UserRule = {
  id: string;
  description: string;
  commands: string[];
  required_flags: string[];
  path_patterns: string[];
  arg_all_of: string[];
  enabled: boolean;
};

export type AppSettings = {
  local_probe: LocalProbe | null;
  /** null = follow the probe suggestion. */
  max_concurrent_sessions: number | null;
  default_timeout_secs: number;
  help_hints_enabled: boolean;
  core_rules: CoreRuleInfo[];
  user_rules: UserRule[];
};

export type HistoryEntry = {
  id: number;
  command: string;
  host_count: number;
  ts: string;
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
