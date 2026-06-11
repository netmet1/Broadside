use keyring::Entry;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "omniterminal";

pub fn probe() -> bool {
    let Ok(entry) = Entry::new(SERVICE, "__probe__") else {
        return false;
    };
    if entry.set_password("probe").is_err() {
        return false;
    }
    let read_ok = entry.get_password().is_ok();
    let _ = entry.delete_credential();
    read_ok
}

pub fn set(key: &str, value: &str) -> AppResult<()> {
    let entry = Entry::new(SERVICE, key)
        .map_err(|e| AppError::Credentials(format!("keyring entry: {e}")))?;
    entry
        .set_password(value)
        .map_err(|e| AppError::Credentials(format!("keyring set: {e}")))?;
    Ok(())
}

pub fn get(key: &str) -> AppResult<Option<String>> {
    let entry = Entry::new(SERVICE, key)
        .map_err(|e| AppError::Credentials(format!("keyring entry: {e}")))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Credentials(format!("keyring get: {e}"))),
    }
}

pub fn delete(key: &str) -> AppResult<()> {
    let entry = Entry::new(SERVICE, key)
        .map_err(|e| AppError::Credentials(format!("keyring entry: {e}")))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Credentials(format!("keyring delete: {e}"))),
    }
}
