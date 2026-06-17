//! Admin-lock commands (opt-in passcode that gates the sensitive controls).
//! The lock is authorization-only — see `crate::admin_lock`.

use serde::Serialize;
use tauri::State;

use super::ssh::with_db;
use crate::admin_lock::{self, AdminLockState};
use crate::db::DbState;
use crate::error::{AppError, AppResult};

#[derive(Serialize)]
pub struct AdminLockStatus {
    /// Whether an admin passcode is configured.
    pub lock_set: bool,
    /// Whether this session has been unlocked.
    pub unlocked: bool,
}

#[tauri::command]
pub fn admin_lock_status(
    db: State<'_, DbState>,
    lock: State<'_, AdminLockState>,
) -> AppResult<AdminLockStatus> {
    let lock_set = with_db(&db, admin_lock::is_set)?;
    Ok(AdminLockStatus {
        lock_set,
        unlocked: lock.is_unlocked(),
    })
}

/// Sets or replaces the admin passcode; returns a one-time recovery code (shown
/// once). Replacing an existing passcode requires the session to be unlocked.
#[tauri::command]
pub fn set_admin_passcode(
    passcode: String,
    db: State<'_, DbState>,
    lock: State<'_, AdminLockState>,
) -> AppResult<String> {
    if with_db(&db, admin_lock::is_set)? && !lock.is_unlocked() {
        return Err(AppError::AdminLocked);
    }
    let recovery = with_db(&db, |conn| admin_lock::set_passcode(conn, &passcode))?;
    lock.set_unlocked(true);
    Ok(recovery)
}

/// Verifies the passcode and unlocks this session on success.
#[tauri::command]
pub fn verify_admin_passcode(
    passcode: String,
    db: State<'_, DbState>,
    lock: State<'_, AdminLockState>,
) -> AppResult<bool> {
    let ok = with_db(&db, |conn| admin_lock::verify_passcode(conn, &passcode))?;
    if ok {
        lock.set_unlocked(true);
    }
    Ok(ok)
}

/// Resets the passcode using the one-time recovery code. Returns the new
/// recovery code on success, or null if the recovery code was wrong.
#[tauri::command]
pub fn reset_admin_passcode(
    recovery_code: String,
    new_passcode: String,
    db: State<'_, DbState>,
    lock: State<'_, AdminLockState>,
) -> AppResult<Option<String>> {
    let result = with_db(&db, |conn| {
        admin_lock::reset_with_recovery(conn, &recovery_code, &new_passcode)
    })?;
    if result.is_some() {
        lock.set_unlocked(true);
    }
    Ok(result)
}

/// Removes the admin lock entirely. Requires the session to be unlocked.
#[tauri::command]
pub fn remove_admin_lock(
    db: State<'_, DbState>,
    lock: State<'_, AdminLockState>,
) -> AppResult<()> {
    if with_db(&db, admin_lock::is_set)? && !lock.is_unlocked() {
        return Err(AppError::AdminLocked);
    }
    with_db(&db, admin_lock::clear)?;
    lock.set_unlocked(false);
    Ok(())
}
