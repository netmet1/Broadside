use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::State;

use crate::credentials::CredentialState;
use crate::db::hosts::{self as host_repo, Host, HostInput};
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::ssh::KeyCheck;

fn lock<'a>(state: &'a State<'_, DbState>) -> AppResult<MutexGuard<'a, Connection>> {
    state
        .0
        .lock()
        .map_err(|_| AppError::State("db mutex poisoned".into()))
}

#[tauri::command]
pub fn list_hosts(state: State<'_, DbState>) -> AppResult<Vec<Host>> {
    let conn = lock(&state)?;
    host_repo::list_all(&conn)
}

#[tauri::command]
pub fn get_host(id: i64, state: State<'_, DbState>) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::get(&conn, id)
}

#[tauri::command]
pub fn create_host(input: HostInput, state: State<'_, DbState>) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::create(&conn, input)
}

#[tauri::command]
pub fn update_host(id: i64, input: HostInput, state: State<'_, DbState>) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::update(&conn, id, input)
}

/// The host's standing answer for shell integration (D-067): `auto`, `always`
/// or `never`.
///
/// Its own command rather than a field on [`HostInput`] for the same reason
/// `login_shell` is: those columns are written by the connect path, and folding
/// them into the form's save would let an ordinary edit overwrite what the last
/// connection learned.
#[tauri::command]
pub fn set_host_shell_integration(
    id: i64,
    pref: Option<String>,
    state: State<'_, DbState>,
) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::set_shell_integration(&conn, id, pref.as_deref())?;
    host_repo::get(&conn, id)
}

/// How often a closed pane asks this host whether it is back, 1-10 seconds,
/// `None` for the default of 3, zero to turn the check off for this host. Its
/// own command for the same reason as `set_host_shell_integration`: it is not
/// part of what a CSV import knows how to say, so importing a host must not be
/// able to state an answer for it.
#[tauri::command]
pub fn set_host_probe_interval(
    id: i64,
    secs: Option<u16>,
    state: State<'_, DbState>,
) -> AppResult<Host> {
    let conn = lock(&state)?;
    host_repo::set_probe_interval(&conn, id, secs)?;
    host_repo::get(&conn, id)
}

/// Is this host's SSH port accepting connections?
///
/// The question a pane sitting on a Reconnect button is really asking, and the
/// reason this probes the port rather than pinging: on a Linux box the network
/// stack answers ICMP some tens of seconds before `sshd` binds, so a ping that
/// has come back means only that the reboot has got as far as the kernel. This
/// goes true at the moment Reconnect would work, which is the moment worth
/// telling anyone about.
///
/// Deliberately async and deliberately short-timeout: it is called on a repeat
/// from every closed pane, and a synchronous version would hold the database
/// lock across a network round trip.
///
/// The timeout is bounded by the caller's interval so probes cannot pile up: a
/// host that is down black-holes the SYN rather than refusing it, so without
/// this a 1-second interval against a dead machine would leave a growing stack
/// of connects each waiting out its own timeout.
#[tauri::command]
pub async fn probe_host_reachable(
    id: i64,
    state: State<'_, DbState>,
) -> AppResult<bool> {
    let (hostname, port, interval) = {
        let conn = lock(&state)?;
        let host = host_repo::get(&conn, id)?;
        // A host with the check turned off still gets a straight answer if
        // something asks: "off" says how often to ask, not what is true. The
        // pane stops calling instead. Falling through with the stored zero
        // would give the connect a zero timeout, i.e. an instant and always
        // wrong "no".
        let interval = match host.probe_interval_secs {
            None | Some(host_repo::PROBE_INTERVAL_OFF) => host_repo::DEFAULT_PROBE_INTERVAL_SECS,
            Some(secs) => secs,
        };
        (host.hostname, host.port, interval)
    };
    let timeout = std::time::Duration::from_millis(u64::from(interval) * 1000);
    Ok(crate::probe::tcp_connect_ms(&hostname, port, timeout)
        .await
        .is_some())
}

/// Writes all hosts to a CSV or `.xlsx` file (chosen by the path's extension)
/// that round-trips through "Import hosts…". Returns the number written.
#[tauri::command]
pub fn export_hosts(path: String, state: State<'_, DbState>) -> AppResult<usize> {
    let hosts = {
        let conn = lock(&state)?;
        host_repo::list_all(&conn)?
    };
    let p = std::path::Path::new(&path);
    let is_xlsx = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("xlsx"));
    if is_xlsx {
        crate::export::write_hosts_xlsx(&hosts, p)?;
    } else {
        crate::export::write_hosts_csv(&hosts, p)?;
    }
    Ok(hosts.len())
}

/// Whether a local path points at an existing file, used by the host form
/// to validate a hand-typed private-key path before saving.
#[tauri::command]
pub fn path_is_file(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

/// Whether a private key file can actually be used, and if not, why, so the
/// host form can say "this key is encrypted, it needs its passphrase" while the
/// key is being chosen, rather than letting the first connect fail with it.
///
/// Async and off the IPC thread on purpose: decrypting a key runs its KDF,
/// which is designed to be slow, and a sync command doing that would hold up
/// every other call in flight.
#[tauri::command]
pub async fn check_private_key(path: String, passphrase: Option<String>) -> KeyCheck {
    tauri::async_runtime::spawn_blocking(move || crate::ssh::check_key(&path, passphrase.as_deref()))
        .await
        .unwrap_or(KeyCheck::Unreadable {
            message: "the key check did not finish".into(),
        })
}

#[tauri::command]
pub fn delete_host(
    id: i64,
    state: State<'_, DbState>,
    cred_state: State<'_, CredentialState>,
) -> AppResult<()> {
    let auth_method = {
        let conn = lock(&state)?;
        host_repo::get(&conn, id)?.auth_method
    };
    if auth_method.is_some() {
        cred_state.clear_host(id)?;
    }
    let conn = lock(&state)?;
    host_repo::delete(&conn, id)
}
