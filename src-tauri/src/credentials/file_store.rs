use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use age::secrecy::{ExposeSecret, SecretString};

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
                Err(AppError::Credentials(_)) => return Ok(false),
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

fn encrypt(plaintext: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let encryptor =
        age::Encryptor::with_user_passphrase(SecretString::from(passphrase.to_string()));
    let mut output = vec![];
    let mut writer = encryptor
        .wrap_output(&mut output)
        .map_err(|e| AppError::Credentials(format!("age encrypt init: {e}")))?;
    writer
        .write_all(plaintext)
        .map_err(|e| AppError::Credentials(format!("age write: {e}")))?;
    writer
        .finish()
        .map_err(|e| AppError::Credentials(format!("age finish: {e}")))?;
    Ok(output)
}

fn decrypt(encrypted: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let decryptor = age::Decryptor::new(encrypted)
        .map_err(|e| AppError::Credentials(format!("age decryptor: {e}")))?;
    let identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_string()));
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| AppError::Credentials(format!("age decrypt: {e}")))?;
    let mut output = vec![];
    reader
        .read_to_end(&mut output)
        .map_err(|e| AppError::Credentials(format!("age read: {e}")))?;
    Ok(output)
}
