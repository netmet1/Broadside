use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use age::secrecy::{ExposeSecret, SecretString};

use crate::crypto::{decrypt, encrypt};
use crate::error::{AppError, AppResult};

pub struct FileStore {
    path: PathBuf,
    state: Mutex<Option<UnlockedState>>,
}

struct UnlockedState {
    passphrase: SecretString,
    secrets: HashMap<String, String>,
}

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(None),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.state.lock().unwrap().is_some()
    }

    /// Returns Ok(true) on successful unlock, Ok(false) on wrong password.
    /// Other errors (IO, malformed file) propagate.
    pub fn unlock(&self, passphrase: &str) -> AppResult<bool> {
        let mut state_guard = self.state.lock().unwrap();
        if state_guard.is_some() {
            return Ok(true);
        }

        let secrets = if self.path.exists() {
            let encrypted = fs::read(&self.path)?;
            match decrypt(&encrypted, passphrase) {
                Ok(plaintext) => serde_json::from_slice::<HashMap<String, String>>(&plaintext)?,
                // Wrong passphrase (or corrupt file) — not an internal error.
                Err(AppError::Crypto(_)) => return Ok(false),
                Err(e) => return Err(e),
            }
        } else {
            HashMap::new()
        };

        *state_guard = Some(UnlockedState {
            passphrase: SecretString::from(passphrase.to_string()),
            secrets,
        });
        Ok(true)
    }

    pub fn get(&self, key: &str) -> AppResult<Option<String>> {
        let state_guard = self.state.lock().unwrap();
        let state = state_guard.as_ref().ok_or(AppError::CredentialsLocked)?;
        Ok(state.secrets.get(key).cloned())
    }

    pub fn set(&self, key: &str, value: &str) -> AppResult<()> {
        let mut state_guard = self.state.lock().unwrap();
        let state = state_guard.as_mut().ok_or(AppError::CredentialsLocked)?;
        state.secrets.insert(key.to_string(), value.to_string());
        persist(&self.path, state)
    }

    pub fn delete_prefix(&self, prefix: &str) -> AppResult<()> {
        let mut state_guard = self.state.lock().unwrap();
        let state = state_guard.as_mut().ok_or(AppError::CredentialsLocked)?;
        state.secrets.retain(|k, _| !k.starts_with(prefix));
        persist(&self.path, state)
    }
}

fn persist(path: &PathBuf, state: &UnlockedState) -> AppResult<()> {
    let json = serde_json::to_vec(&state.secrets)?;
    let encrypted = encrypt(&json, state.passphrase.expose_secret())?;
    let tmp = path.with_extension("age.tmp");
    fs::write(&tmp, &encrypted)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
