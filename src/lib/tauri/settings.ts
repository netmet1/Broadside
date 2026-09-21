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

/** A user-added guard rule (D-014 structured form, no raw regex). */
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
 * `both` runs in either.
 *
 * `serial` is a console cable and stands alone: `both` does not reach it,
 * because "both" has always meant both shell *languages* and the far end of a
 * console cable speaks neither. There are no built-in serial shortcuts either,
 * so until the operator adds one the picker and Go are greyed out rather than
 * offering commands that cannot work. */
export type ShortcutScope = "ssh" | "local" | "both" | "serial";

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

/** Where a skill run's record goes.
 *
 * `remote` is the host's own shell history, which is not something Broadside
 * writes: it means the shell is left recording the skill's commands, the way
 * build 57-2 did. The other two put the record in Broadside's Log tab, and
 * `skill` additionally asks the shell to stop keeping one. */
export type SkillLogWhere = "skill" | "remote" | "both";

/** How much of a run is written down. */
export type SkillLogDetail = "summary" | "itemized" | "panel" | "debug";

/** How the skill log reads on screen and on the way out. A display choice: the
 * file itself is always JSONL, so nothing is lost by picking prose. */
export type SkillLogFormat = "text" | "json";

export type SkillLogPrefs = {
  where: SkillLogWhere;
  detail: SkillLogDetail;
  format: SkillLogFormat;
};

export type AppSettings = {
  local_probe: LocalProbe | null;
  /** null = follow the probe suggestion. */
  max_concurrent_sessions: number | null;
  default_timeout_secs: number;
  /** Above how many at once a bulk action on the Terminals page asks first. */
  bulk_confirm_over: number;
  help_hints_enabled: boolean;
  sudo_autofill_enabled: boolean;
  /** Whether the connect setup line deletes its own bash history entry.
   * Off unless the operator turned it on. */
  history_scrub_enabled: boolean;
  core_rules: CoreRuleInfo[];
  user_rules: UserRule[];
  core_shortcuts: CoreShortcut[];
  user_shortcuts: ShortcutCommand[];
  terminal_font_family: string;
  terminal_font_size: number;
  app_font_size: number;
  terminal_scrollback: number;
  skill_log: SkillLogPrefs;
};

/** Saved the moment a dropdown changes, so it takes effect on the next host to
 * start rather than at the next launch. */
export function setSkillLogPrefs(prefs: SkillLogPrefs): Promise<void> {
  return invoke<void>("set_skill_log_prefs", { prefs });
}

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
  bulk_confirm_over: number;
}): Promise<void> {
  return invoke<void>("set_app_settings", { input });
}

/** Above how many at once a bulk action on the Terminals page asks first, and
 * the range the setting offers. Kept in step with the Rust constants: the page
 * needs the default before the settings probe has answered, or the first click
 * after a cold start would be guarded by `undefined`.
 *
 * The ceiling is low on purpose. This setting exists so an operator who
 * routinely opens eight shells stops being asked, not so the guard can be
 * turned off. */
export const DEFAULT_BULK_CONFIRM_OVER = 5;
export const MIN_BULK_CONFIRM_OVER = 1;
export const MAX_BULK_CONFIRM_OVER = 11;

export function setHelpHintsEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_help_hints_enabled", { enabled });
}

export function setSudoAutofillEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_sudo_autofill_enabled", { enabled });
}

/** Whether the line Broadside types on connect takes itself back out of the
 * host's bash history. Off by default, so nothing is deleted anywhere until
 * this is asked for. Read when a terminal opens, so it applies to the next one
 * rather than to a session already running. */
export function setHistoryScrubEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("set_history_scrub_enabled", { enabled });
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
  terminal_scrollback: number;
};

export function setUiSettings(input: UiSettingsInput): Promise<void> {
  return invoke<void>("set_ui_settings", { input });
}

/** How often SSH connections opened from now on should send a keepalive, in
 * seconds; 0 turns it off. Not stored in the settings database: the preference
 * itself lives in localStorage with the other per-machine UI prefs, and this
 * pushes it down to the connection layer at startup and on every change. It
 * applies to the *next* connection, never to one already open. */
export function setSshKeepalive(secs: number): Promise<void> {
  return invoke<void>("set_ssh_keepalive", { secs });
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
  /** Custom local-shell entries the restore refused to carry over: a launcher
   * entry names a program to run, and a backup file is not where that decision
   * gets made. Re-add them under Settings. */
  dropped_terminals: number;
  /** Trusted host keys the restore cleared, so the first connect to each host
   * asks again instead of trusting whatever the file said. */
  cleared_host_keys: number;
  /** Saved shell profiles whose startup command the restore emptied. The
   * profile comes back; the command it would type into a shell on the next
   * click does not, because a file is not where that gets decided. */
  cleared_startup_commands: number;
  /** Saved shell profiles that named a custom local shell. Every custom entry
   * is dropped above, so each of these profiles was pointed at nothing rather
   * than left holding an id the next entry added would take. Pick the shell
   * again in Edit once the entry is back. */
  orphaned_custom_profiles: number;
  /** True when the restored file had sudo auto-fill on and the restore turned
   * it back off. A backup carries no credentials, so a file arriving with that
   * switch on would be turning password injection on for passwords already on
   * this machine. */
  sudo_autofill_disabled: boolean;
};

/** Restores a backup `.db` over the live database (hosts, settings, command
 * history, shell profiles). This OVERWRITES all current data. Credentials are
 * never in a backup, so restored hosts may need their password re-entered.
 * Three things deliberately do NOT come back: custom local-shell entries,
 * trusted host keys, and the startup commands on shell profiles, each of which
 * would otherwise let a file somebody else made decide what runs or what is
 * trusted (see the backend command for the reasoning).
 * Reload the app afterwards so every page re-reads the restored database. */
export function restoreAppData(path: string): Promise<RestoreReport> {
  return invoke<RestoreReport>("restore_app_data", { path });
}
