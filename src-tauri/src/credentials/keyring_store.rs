use keyring::Entry;

use crate::error::{AppError, AppResult};

/// The service name every saved password lives under for the released app.
/// Never change it: installed copies would lose every saved password.
const SERVICE: &str = "broadside";
/// The released app's Tauri identifier.
const RELEASE_IDENTIFIER: &str = "com.broadside.app";

/// The Credential Manager service for this build. The released app keeps
/// "broadside"; a build with any other identifier (a sandbox test build) gets
/// its own, so its host 1 is never the real host 1.
pub fn service_for(identifier: &str) -> String {
    if identifier == RELEASE_IDENTIFIER {
        SERVICE.to_string()
    } else {
        format!("{SERVICE}:{identifier}")
    }
}

pub fn probe(service: &str) -> bool {
    let Ok(entry) = Entry::new(service, "__probe__") else {
        return false;
    };
    if entry.set_password("probe").is_err() {
        return false;
    }
    let read_ok = entry.get_password().is_ok();
    let _ = entry.delete_credential();
    read_ok
}

pub fn set(service: &str, key: &str, value: &str) -> AppResult<()> {
    let entry = Entry::new(service, key)
        .map_err(|e| AppError::Credentials(format!("keyring entry: {e}")))?;
    entry
        .set_password(value)
        .map_err(|e| AppError::Credentials(format!("keyring set: {e}")))?;
    Ok(())
}

pub fn get(service: &str, key: &str) -> AppResult<Option<String>> {
    let entry = Entry::new(service, key)
        .map_err(|e| AppError::Credentials(format!("keyring entry: {e}")))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Credentials(format!("keyring get: {e}"))),
    }
}

pub fn delete(service: &str, key: &str) -> AppResult<()> {
    let entry = Entry::new(service, key)
        .map_err(|e| AppError::Credentials(format!("keyring entry: {e}")))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Credentials(format!("keyring delete: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_released_app_keeps_its_service_name() {
        assert_eq!(service_for("com.broadside.app"), "broadside");
    }

    #[test]
    fn a_sandbox_build_gets_its_own_service() {
        assert_eq!(
            service_for("com.broadside.test"),
            "broadside:com.broadside.test"
        );
    }

    /// Hits the real Credential Manager, so it only runs when asked:
    /// `cargo test --lib keyring_store -- --ignored`.
    #[test]
    #[ignore]
    fn a_sandbox_service_name_is_accepted_and_kept_apart() {
        let sandbox = service_for("com.broadside.test");
        assert!(probe(&sandbox));
        let key = "__sandbox_apart_probe__";
        set(&sandbox, key, "sandbox").unwrap();
        assert_eq!(get(SERVICE, key).unwrap(), None);
        assert_eq!(get(&sandbox, key).unwrap().as_deref(), Some("sandbox"));
        delete(&sandbox, key).unwrap();
        assert_eq!(get(&sandbox, key).unwrap(), None);
    }
}
