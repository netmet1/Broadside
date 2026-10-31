use keyring::Entry;

use crate::error::{AppError, AppResult};

/// The service name every saved password lives under for the released app.
/// Never change it: installed copies would lose every saved password.
const SERVICE: &str = "broadside";
/// The released app's Tauri identifiers: Windows, then macOS (set by
/// `tauri.macos.conf.json`). The Mac one differs only because an identifier
/// ending in `.app` makes Finder show the data folder as a broken app; both are
/// the real app and both keep the plain service name.
const RELEASE_IDENTIFIERS: [&str; 2] = ["com.broadside.app", "com.broadside.desktop"];

/// The credential store service (Credential Manager / Keychain) for this build.
/// The released app keeps "broadside"; a build with any other identifier (a
/// sandbox test build) gets its own, so its host 1 is never the real host 1.
pub fn service_for(identifier: &str) -> String {
    if RELEASE_IDENTIFIERS.contains(&identifier) {
        SERVICE.to_string()
    } else {
        format!("{SERVICE}:{identifier}")
    }
}

/// Names the platform's real store as keyring's backend.
///
/// The features in Cargo.toml already select it, so at run time this changes
/// nothing. It is here for the build: `keyring::macos` and `keyring::windows`
/// exist only while their feature is on, so losing one fails to compile. Without
/// it, keyring quietly falls back to an in-memory mock, `probe` passes against
/// that, and every saved password is gone when the app quits.
fn use_native_store() {
    #[cfg(target_os = "macos")]
    keyring::set_default_credential_builder(keyring::macos::default_credential_builder());
    #[cfg(windows)]
    keyring::set_default_credential_builder(keyring::windows::default_credential_builder());
}

pub fn probe(service: &str) -> bool {
    use_native_store();
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
    fn the_released_mac_app_shares_the_service_name() {
        assert_eq!(service_for("com.broadside.desktop"), "broadside");
    }

    #[test]
    fn a_sandbox_build_gets_its_own_service() {
        assert_eq!(
            service_for("com.broadside.test"),
            "broadside:com.broadside.test"
        );
    }

    /// Hits the real Credential Manager / Keychain, so it only runs when asked:
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
