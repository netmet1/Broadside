use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::ssh::with_db;
use crate::db::{history, hosts as host_repo, settings, DbState};
use crate::error::AppResult;
use crate::guard::{self, CoreRuleInfo, UserRule};
use crate::probe::{self, HostLatency, LocalProbe};

const KEY_GUARD_RULES: &str = "guard_user_rules";
const KEY_LOCAL_PROBE: &str = "local_probe";
const KEY_MAX_SESSIONS: &str = "max_concurrent_sessions";
const KEY_DEFAULT_TIMEOUT: &str = "default_timeout_secs";
const KEY_HELP_HINTS: &str = "help_hints_enabled";
/// Global sudo password auto-fill toggle (D-065). Default on; off = stored sudo
/// passwords are never injected into interactive terminals. Public so the PTY
/// open path can read the same key when deciding whether to arm injection.
pub const KEY_SUDO_AUTOFILL: &str = "sudo_autofill_enabled";
const KEY_SHORTCUTS: &str = "shortcut_commands";
const KEY_TERMINAL_FONT_FAMILY: &str = "terminal_font_family";
const KEY_TERMINAL_FONT_SIZE: &str = "terminal_font_size";
const KEY_APP_FONT_SIZE: &str = "app_font_size";

pub const DEFAULT_TERMINAL_FONT_FAMILY: &str = "Consolas, 'Cascadia Mono', monospace";
pub const DEFAULT_TERMINAL_FONT_SIZE: u16 = 13;
pub const DEFAULT_APP_FONT_SIZE: u16 = 16;

/// Where a shortcut command can run. `Ssh` covers remote SSH hosts and local
/// WSL tabs (both run Linux); `Local` covers local Command Prompt and PowerShell
/// tabs (Windows). Defaults to `Ssh` so shortcuts saved before scopes existed
/// (and any JSON missing the field) keep their original SSH behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutScope {
    #[default]
    Ssh,
    Local,
}

/// Built-in SSH/Linux shortcut commands (D-054). Also offered on WSL tabs, which
/// run Linux. Like guard core rules these live in code and cannot be removed.
pub const CORE_SHORTCUTS_SSH: [&str; 6] = [
    "ls -la",
    "uptime",
    "sudo apt update",
    "sudo apt upgrade",
    "sudo apt update && sudo apt upgrade",
    "htop",
];

/// Built-in Command Prompt / PowerShell shortcut commands. Every entry is valid
/// in BOTH cmd.exe and PowerShell so it runs whichever Windows shell the tab is.
pub const CORE_SHORTCUTS_LOCAL: [&str; 6] =
    ["dir", "whoami", "hostname", "ipconfig", "tasklist", "cls"];

/// A built-in shortcut with its scope, sent to the Settings page.
#[derive(Debug, Clone, Serialize)]
pub struct CoreShortcut {
    pub command: String,
    pub scope: ShortcutScope,
}

/// A user-defined shortcut command (Settings CRUD, D-054).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutCommand {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub scope: ShortcutScope,
}

/// All built-in shortcuts (SSH set then local set), each tagged with its scope.
fn core_shortcuts() -> Vec<CoreShortcut> {
    CORE_SHORTCUTS_SSH
        .iter()
        .map(|c| CoreShortcut {
            command: c.to_string(),
            scope: ShortcutScope::Ssh,
        })
        .chain(CORE_SHORTCUTS_LOCAL.iter().map(|c| CoreShortcut {
            command: c.to_string(),
            scope: ShortcutScope::Local,
        }))
        .collect()
}

/// Everything the Settings page needs in one fetch.
#[derive(Serialize)]
pub struct AppSettings {
    pub local_probe: Option<LocalProbe>,
    /// None = follow the probe suggestion.
    pub max_concurrent_sessions: Option<usize>,
    pub default_timeout_secs: u64,
    pub help_hints_enabled: bool,
    pub sudo_autofill_enabled: bool,
    pub core_rules: Vec<CoreRuleInfo>,
    pub user_rules: Vec<UserRule>,
    pub core_shortcuts: Vec<CoreShortcut>,
    pub user_shortcuts: Vec<ShortcutCommand>,
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    pub app_font_size: u16,
}

#[derive(Deserialize)]
pub struct AppSettingsInput {
    pub max_concurrent_sessions: Option<usize>,
    pub default_timeout_secs: u64,
}

pub(crate) fn load_user_rules(conn: &rusqlite::Connection) -> AppResult<Vec<UserRule>> {
    match settings::get(conn, KEY_GUARD_RULES)? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(Vec::new()),
    }
}

pub(crate) fn load_max_sessions(conn: &rusqlite::Connection) -> AppResult<Option<usize>> {
    Ok(settings::get(conn, KEY_MAX_SESSIONS)?.and_then(|v| v.parse().ok()))
}

pub(crate) fn load_cached_probe(conn: &rusqlite::Connection) -> AppResult<Option<LocalProbe>> {
    Ok(settings::get(conn, KEY_LOCAL_PROBE)?
        .and_then(|json| serde_json::from_str(&json).ok()))
}

pub(crate) fn load_user_shortcuts(
    conn: &rusqlite::Connection,
) -> AppResult<Vec<ShortcutCommand>> {
    match settings::get(conn, KEY_SHORTCUTS)? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn get_app_settings(state: State<'_, DbState>) -> AppResult<AppSettings> {
    with_db(&state, |conn| {
        Ok(AppSettings {
            local_probe: load_cached_probe(conn)?,
            max_concurrent_sessions: load_max_sessions(conn)?,
            default_timeout_secs: settings::get(conn, KEY_DEFAULT_TIMEOUT)?
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
            help_hints_enabled: settings::get_bool(conn, KEY_HELP_HINTS, true)?,
            sudo_autofill_enabled: settings::get_bool(conn, KEY_SUDO_AUTOFILL, true)?,
            core_rules: guard::core_rule_infos(),
            user_rules: load_user_rules(conn)?,
            core_shortcuts: core_shortcuts(),
            user_shortcuts: load_user_shortcuts(conn)?,
            terminal_font_family: settings::get(conn, KEY_TERMINAL_FONT_FAMILY)?
                .unwrap_or_else(|| DEFAULT_TERMINAL_FONT_FAMILY.to_string()),
            terminal_font_size: settings::get(conn, KEY_TERMINAL_FONT_SIZE)?
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_TERMINAL_FONT_SIZE),
            app_font_size: settings::get(conn, KEY_APP_FONT_SIZE)?
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_APP_FONT_SIZE),
        })
    })
}

#[derive(Deserialize)]
pub struct UiSettingsInput {
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    pub app_font_size: u16,
}

/// Appearance settings: terminal font + size, application font size.
#[tauri::command]
pub fn set_ui_settings(input: UiSettingsInput, state: State<'_, DbState>) -> AppResult<()> {
    let family = input.terminal_font_family.trim();
    let family = if family.is_empty() {
        DEFAULT_TERMINAL_FONT_FAMILY
    } else {
        family
    };
    with_db(&state, |conn| {
        settings::set(conn, KEY_TERMINAL_FONT_FAMILY, family)?;
        settings::set(
            conn,
            KEY_TERMINAL_FONT_SIZE,
            &input.terminal_font_size.clamp(8, 32).to_string(),
        )?;
        settings::set(
            conn,
            KEY_APP_FONT_SIZE,
            &input.app_font_size.clamp(12, 20).to_string(),
        )
    })
}

/// Wholesale replace of the user shortcut list (mirrors save_guard_rules).
#[tauri::command]
pub fn save_shortcuts(
    shortcuts: Vec<ShortcutCommand>,
    state: State<'_, DbState>,
) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    for s in &shortcuts {
        if s.id.trim().is_empty() {
            return Err(crate::error::AppError::InvalidInput(
                "shortcut id is required".into(),
            ));
        }
        if s.command.trim().is_empty() {
            return Err(crate::error::AppError::InvalidInput(
                "shortcut command cannot be empty".into(),
            ));
        }
        if !seen.insert(s.id.clone()) {
            return Err(crate::error::AppError::InvalidInput(format!(
                "duplicate shortcut id: {}",
                s.id
            )));
        }
    }
    let json = serde_json::to_string(&shortcuts)?;
    with_db(&state, |conn| settings::set(conn, KEY_SHORTCUTS, &json))
}

#[tauri::command]
pub fn set_app_settings(
    input: AppSettingsInput,
    state: State<'_, DbState>,
) -> AppResult<()> {
    with_db(&state, |conn| {
        match input.max_concurrent_sessions {
            Some(n) => settings::set(conn, KEY_MAX_SESSIONS, &n.clamp(1, 2048).to_string())?,
            None => {
                let _ = conn.execute(
                    "DELETE FROM settings WHERE key = ?1",
                    rusqlite::params![KEY_MAX_SESSIONS],
                );
            }
        }
        settings::set(
            conn,
            KEY_DEFAULT_TIMEOUT,
            &input.default_timeout_secs.clamp(1, 3600).to_string(),
        )
    })
}

/// Resets app *preferences* to their built-in defaults (the "reset everything"
/// action). Deletes the config keys so the getters fall back to defaults:
/// max sessions, default timeout, help hints, and the font settings. It does
/// NOT touch user content — hosts, credentials, guard rules, shortcuts, command
/// history and the audit log are all left intact. The frontend clears its own
/// UI prefs (theme, layout, sort) from localStorage alongside this.
#[tauri::command]
pub fn reset_app_settings(
    state: State<'_, DbState>,
    lock_state: State<'_, crate::admin_lock::AdminLockState>,
) -> AppResult<()> {
    with_db(&state, |conn| {
        crate::admin_lock::ensure_unlocked(conn, &lock_state)?;
        for key in [
            KEY_MAX_SESSIONS,
            KEY_DEFAULT_TIMEOUT,
            KEY_HELP_HINTS,
            KEY_TERMINAL_FONT_FAMILY,
            KEY_TERMINAL_FONT_SIZE,
            KEY_APP_FONT_SIZE,
        ] {
            conn.execute("DELETE FROM settings WHERE key = ?1", rusqlite::params![key])?;
        }
        Ok(())
    })
}

/// Toggle for the bottom-bar help hints; saved immediately on change (same
/// pattern as the audit toggle).
#[tauri::command]
pub fn set_help_hints_enabled(enabled: bool, state: State<'_, DbState>) -> AppResult<()> {
    with_db(&state, |conn| {
        settings::set(conn, KEY_HELP_HINTS, if enabled { "true" } else { "false" })
    })
}

/// Global sudo password auto-fill toggle (D-065). Off = stored sudo passwords
/// are never injected into interactive terminals. Saved immediately. The PTY
/// open path reads the same key, so disabling it takes effect on the next
/// terminal opened. Intentionally NOT cleared by `reset_app_settings` — a
/// preferences reset must never silently re-enable sudo auto-fill.
#[tauri::command]
pub fn set_sudo_autofill_enabled(
    enabled: bool,
    state: State<'_, DbState>,
    lock_state: State<'_, crate::admin_lock::AdminLockState>,
) -> AppResult<()> {
    with_db(&state, |conn| {
        crate::admin_lock::ensure_unlocked(conn, &lock_state)?;
        settings::set(conn, KEY_SUDO_AUTOFILL, if enabled { "true" } else { "false" })
    })
}

/// Wholesale replace of the user rule list (frontend owns add/toggle/delete).
/// Core rules are not stored — they live in code and cannot be removed
/// (D-014 v0.1a).
#[tauri::command]
pub fn save_guard_rules(rules: Vec<UserRule>, state: State<'_, DbState>) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    for rule in &rules {
        guard::validate_user_rule(rule)?;
        if !seen.insert(rule.id.clone()) {
            return Err(crate::error::AppError::InvalidInput(format!(
                "duplicate rule id: {}",
                rule.id
            )));
        }
    }
    let json = serde_json::to_string(&rules)?;
    with_db(&state, |conn| settings::set(conn, KEY_GUARD_RULES, &json))
}

/// Re-runs the local resource probe and caches the result (Recalibrate).
#[tauri::command]
pub fn recalibrate_probe(state: State<'_, DbState>) -> AppResult<LocalProbe> {
    let result = probe::local_probe();
    let json = serde_json::to_string(&result)?;
    with_db(&state, |conn| settings::set(conn, KEY_LOCAL_PROBE, &json))?;
    Ok(result)
}

/// On-demand network probe: TCP connect timing for every configured host.
#[tauri::command]
pub async fn network_probe(state: State<'_, DbState>) -> AppResult<Vec<HostLatency>> {
    let hosts = with_db(&state, host_repo::list_all)?;
    let mut handles = Vec::with_capacity(hosts.len());
    for host in hosts {
        handles.push(tauri::async_runtime::spawn(async move {
            let connect_ms =
                probe::tcp_connect_ms(&host.hostname, host.port, Duration::from_secs(5)).await;
            HostLatency {
                host_id: host.id,
                label: host.label,
                connect_ms,
            }
        }));
    }
    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(latency) = h.await {
            out.push(latency);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn command_history(
    limit: usize,
    state: State<'_, DbState>,
) -> AppResult<Vec<history::HistoryEntry>> {
    with_db(&state, |conn| history::recent(conn, limit.clamp(1, 5000)))
}

#[tauri::command]
pub fn clear_command_history(state: State<'_, DbState>) -> AppResult<usize> {
    with_db(&state, history::clear)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_without_scope_defaults_to_ssh() {
        // Shortcuts saved before scopes existed have no `scope` field; they must
        // deserialize as Ssh so they keep working on SSH/WSL tabs.
        let legacy = r#"{"id":"shortcut-1","command":"ls -la"}"#;
        let parsed: ShortcutCommand = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.scope, ShortcutScope::Ssh);
    }

    #[test]
    fn scope_round_trips_as_lowercase() {
        let s = ShortcutCommand {
            id: "x".into(),
            command: "dir".into(),
            scope: ShortcutScope::Local,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"scope\":\"local\""), "got {json}");
        let back: ShortcutCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(back.scope, ShortcutScope::Local);
    }

    #[test]
    fn core_shortcuts_are_six_ssh_then_six_local() {
        let cores = core_shortcuts();
        assert_eq!(cores.len(), 12);
        assert!(cores[..6].iter().all(|c| c.scope == ShortcutScope::Ssh));
        assert!(cores[6..].iter().all(|c| c.scope == ShortcutScope::Local));
        assert_eq!(cores[0].command, "ls -la");
        assert_eq!(cores[6].command, "dir");
    }
}
