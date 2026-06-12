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

/// Everything the Settings page needs in one fetch.
#[derive(Serialize)]
pub struct AppSettings {
    pub local_probe: Option<LocalProbe>,
    /// None = follow the probe suggestion.
    pub max_concurrent_sessions: Option<usize>,
    pub default_timeout_secs: u64,
    pub help_hints_enabled: bool,
    pub core_rules: Vec<CoreRuleInfo>,
    pub user_rules: Vec<UserRule>,
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
            core_rules: guard::core_rule_infos(),
            user_rules: load_user_rules(conn)?,
        })
    })
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

/// Toggle for the bottom-bar help hints; saved immediately on change (same
/// pattern as the audit toggle).
#[tauri::command]
pub fn set_help_hints_enabled(enabled: bool, state: State<'_, DbState>) -> AppResult<()> {
    with_db(&state, |conn| {
        settings::set(conn, KEY_HELP_HINTS, if enabled { "true" } else { "false" })
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
