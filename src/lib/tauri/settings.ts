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

/** Where a shortcut runs: `ssh` covers remote SSH hosts and local WSL tabs (both
 * Linux); `local` covers local Command Prompt and PowerShell tabs (Windows);
 * `both` runs in either. */
export type ShortcutScope = "ssh" | "local" | "both";

/** A user-defined shortcut command (D-054). */
export type ShortcutCommand = {
  id: string;
  command: string;
  scope: ShortcutScope;
  /** Optional friendly name shown in the dropdown/list instead of the raw
   * command. null/empty = fall back to showing the command itself. */
  label?: string | null;
};

/** A built-in shortcut command with its scope. */
export type CoreShortcut = {
  command: string;
  scope: ShortcutScope;
};

export type AppSettings = {
  local_probe: LocalProbe | null;
  /** null = follow the probe suggestion. */
  max_concurrent_sessions: number | null;
  default_timeout_secs: number;
  help_hints_enabled: boolean;
  sudo_autofill_enabled: boolean;
  core_rules: CoreRuleInfo[];
  user_rules: UserRule[];
  core_shortcuts: CoreShortcut[];
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

export function setSudoAutofillEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_sudo_autofill_enabled", { enabled });
}

/** Opt-in admin lock state: `lock_set` = a passcode is configured;
 * `unlocked` = this session has been unlocked (re-locks on app restart). */
export type AdminLockStatus = { lock_set: boolean; unlocked: boolean };

export function adminLockStatus(): Promise<AdminLockStatus> {
  return invoke<AdminLockStatus>("admin_lock_status");
}

/** Set/replace the admin passcode. Returns the one-time recovery code. */
export function setAdminPasscode(passcode: string): Promise<string> {
  return invoke<string>("set_admin_passcode", { passcode });
}

/** Verify the passcode and unlock this session. */
export function verifyAdminPasscode(passcode: string): Promise<boolean> {
  return invoke<boolean>("verify_admin_passcode", { passcode });
}

/** Reset the passcode with the recovery code. Returns the NEW recovery code, or
 * null if the recovery code was wrong. */
export function resetAdminPasscode(
  recoveryCode: string,
  newPasscode: string,
): Promise<string | null> {
  return invoke<string | null>("reset_admin_passcode", {
    recoveryCode,
    newPasscode,
  });
}

/** Remove the admin lock entirely (requires an unlocked session). */
export function removeAdminLock(): Promise<void> {
  return invoke<void>("remove_admin_lock");
}

/** Resets app preferences (timeouts, sessions, fonts, hints) to defaults.
 * Does not touch hosts, credentials, guard rules, shortcuts or history. The
 * caller also clears its own localStorage UI prefs and reloads. */
export function resetAppSettings(): Promise<void> {
  return invoke<void>("reset_app_settings");
}

/** Danger Zone wipe: deletes every host and removes each host's stored
 * credentials (password / passphrase / sudo) from Windows Credential Manager.
 * Admin-lock gated. Leaves preferences, guard rules, shortcuts, command history,
 * trusted host keys and the admin lock intact. Returns the number of hosts
 * deleted. The caller should refresh the hosts list afterwards. */
export function destroyAllHosts(): Promise<number> {
  return invoke<number>("destroy_all_hosts");
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

export type RestoreReport = {
  host_count: number;
};

/** Restores a backup `.db` over the live database (hosts, settings, trusted
 * host keys, command history). This OVERWRITES all current data. Credentials
 * are never in a backup, so restored hosts may need their password re-entered.
 * Reload the app afterwards so every page re-reads the restored database. */
export function restoreAppData(path: string): Promise<RestoreReport> {
  return invoke<RestoreReport>("restore_app_data", { path });
}
