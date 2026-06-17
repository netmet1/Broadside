//! Opt-in **admin lock** (policy-grade): an admin can set a passcode that gates
//! the sensitive controls (sudo auto-fill toggle, credential editing, reset).
//! It is an *authorization* check, NOT an encryption key — it hashes the
//! passcode (argon2) and verifies on demand, so losing it never loses any data
//! (worst case the admin resets the lock with the one-time recovery code, or
//! clears the settings keys). Unlock state is per-session and re-locks on every
//! app restart. See the security plan + decision log.

use std::sync::atomic::{AtomicBool, Ordering};

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use rusqlite::Connection;

use crate::db::settings;
use crate::error::{AppError, AppResult};

/// PHC-string hash of the admin passcode (absent = no lock set).
const KEY_LOCK_HASH: &str = "admin_lock_hash";
/// PHC-string hash of the one-time recovery code.
const KEY_RECOVERY_HASH: &str = "admin_lock_recovery_hash";

const MIN_PASSCODE_LEN: usize = 4;
const MAX_PASSCODE_LEN: usize = 128;

/// Per-session unlock flag. Default locked; never persisted, so the app re-locks
/// on every launch (good for shared machines).
#[derive(Default)]
pub struct AdminLockState {
    unlocked: AtomicBool,
}

impl AdminLockState {
    pub fn is_unlocked(&self) -> bool {
        self.unlocked.load(Ordering::Relaxed)
    }
    pub fn set_unlocked(&self, value: bool) {
        self.unlocked.store(value, Ordering::Relaxed);
    }
}

/// Whether an admin passcode has been configured.
pub fn is_set(conn: &Connection) -> AppResult<bool> {
    Ok(settings::get(conn, KEY_LOCK_HASH)?.is_some())
}

/// Gate helper: Ok if no lock is set or the session is unlocked, else AdminLocked.
pub fn ensure_unlocked(conn: &Connection, state: &AdminLockState) -> AppResult<()> {
    if is_set(conn)? && !state.is_unlocked() {
        return Err(AppError::AdminLocked);
    }
    Ok(())
}

fn validate_passcode(passcode: &str) -> AppResult<()> {
    let len = passcode.chars().count();
    if len < MIN_PASSCODE_LEN || len > MAX_PASSCODE_LEN {
        return Err(AppError::InvalidInput(format!(
            "passcode must be {MIN_PASSCODE_LEN}–{MAX_PASSCODE_LEN} characters"
        )));
    }
    Ok(())
}

fn hash_secret(secret: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(secret.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Crypto(format!("argon2 hash: {e}")))
}

fn verify_secret(secret: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// A human-friendly recovery code: 20 chars from an unambiguous base32 alphabet
/// (no 0/O/1/I/L), grouped `XXXXX-XXXXX-XXXXX-XXXXX` (~100 bits).
fn generate_recovery_code() -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789#"; // 32 chars
    let mut bytes = [0u8; 20];
    OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity(23);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && i % 5 == 0 {
            out.push('-');
        }
        out.push(ALPHABET[(b & 0x1F) as usize] as char);
    }
    out
}

/// Sets (or replaces) the admin passcode and returns a freshly-generated
/// one-time recovery code (shown to the user once; only its hash is stored).
pub fn set_passcode(conn: &Connection, passcode: &str) -> AppResult<String> {
    validate_passcode(passcode)?;
    let recovery = generate_recovery_code();
    settings::set(conn, KEY_LOCK_HASH, &hash_secret(passcode)?)?;
    settings::set(conn, KEY_RECOVERY_HASH, &hash_secret(&recovery)?)?;
    Ok(recovery)
}

/// Verifies a passcode against the stored hash. False if no lock is set.
pub fn verify_passcode(conn: &Connection, passcode: &str) -> AppResult<bool> {
    match settings::get(conn, KEY_LOCK_HASH)? {
        Some(phc) => Ok(verify_secret(passcode, &phc)),
        None => Ok(false),
    }
}

/// Resets the passcode using the recovery code. Returns the NEW recovery code on
/// success, or None if the recovery code didn't match.
pub fn reset_with_recovery(
    conn: &Connection,
    recovery_code: &str,
    new_passcode: &str,
) -> AppResult<Option<String>> {
    validate_passcode(new_passcode)?;
    let stored = match settings::get(conn, KEY_RECOVERY_HASH)? {
        Some(h) => h,
        None => return Ok(None),
    };
    if !verify_secret(recovery_code.trim(), &stored) {
        return Ok(None);
    }
    Ok(Some(set_passcode(conn, new_passcode)?))
}

/// Removes the admin lock entirely (both hashes).
pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM settings WHERE key IN (?1, ?2)",
        rusqlite::params![KEY_LOCK_HASH, KEY_RECOVERY_HASH],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn set_verify_and_recovery_roundtrip() {
        let conn = mem();
        assert!(!is_set(&conn).unwrap());

        let recovery = set_passcode(&conn, "hunter2").unwrap();
        assert!(is_set(&conn).unwrap());
        assert!(verify_passcode(&conn, "hunter2").unwrap());
        assert!(!verify_passcode(&conn, "wrong").unwrap());

        // Wrong recovery code rejected.
        assert!(reset_with_recovery(&conn, "BOGUS", "newpass")
            .unwrap()
            .is_none());
        // Correct recovery resets the passcode and mints a new recovery code.
        let new_recovery = reset_with_recovery(&conn, &recovery, "newpass")
            .unwrap()
            .expect("recovery should succeed");
        assert_ne!(recovery, new_recovery);
        assert!(verify_passcode(&conn, "newpass").unwrap());
        assert!(!verify_passcode(&conn, "hunter2").unwrap());

        clear(&conn).unwrap();
        assert!(!is_set(&conn).unwrap());
        assert!(!verify_passcode(&conn, "newpass").unwrap());
    }

    #[test]
    fn ensure_unlocked_semantics() {
        let conn = mem();
        let state = AdminLockState::default();
        // No lock set → always allowed even while locked.
        ensure_unlocked(&conn, &state).unwrap();
        set_passcode(&conn, "pass").unwrap();
        // Lock set + locked → denied.
        assert!(ensure_unlocked(&conn, &state).is_err());
        state.set_unlocked(true);
        ensure_unlocked(&conn, &state).unwrap();
    }

    #[test]
    fn short_passcode_rejected() {
        let conn = mem();
        assert!(set_passcode(&conn, "ab").is_err());
    }
}
