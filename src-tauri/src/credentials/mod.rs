use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;

use crate::error::{AppError, AppResult};

mod file_store;
mod keyring_store;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthInput {
    Password { value: String },
    Key { path: String, passphrase: Option<String> },
}

enum Backend {
    Keyring,
    File(file_store::FileStore),
}

pub struct CredentialState {
    inner: Mutex<Backend>,
}

impl CredentialState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let backend = if keyring_store::probe() {
            Backend::Keyring
        } else {
            Backend::File(file_store::FileStore::new(
                app_data_dir.join("credentials.age"),
            ))
        };
        Self {
            inner: Mutex::new(backend),
        }
    }

    #[cfg(test)]
    pub fn new_file_only(path: PathBuf) -> Self {
        Self {
            inner: Mutex::new(Backend::File(file_store::FileStore::new(path))),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        let backend = self.inner.lock().unwrap();
        match &*backend {
            Backend::Keyring => true,
            Backend::File(fs) => fs.is_unlocked(),
        }
    }

    pub fn requires_master_password(&self) -> bool {
        let backend = self.inner.lock().unwrap();
        matches!(&*backend, Backend::File(_))
    }

    pub fn unlock(&self, passphrase: &str) -> AppResult<bool> {
        let mut backend = self.inner.lock().unwrap();
        match &mut *backend {
            Backend::Keyring => Ok(true),
            Backend::File(fs) => fs.unlock(passphrase),
        }
    }

    pub fn apply_auth(&self, host_id: i64, auth: &AuthInput) -> AppResult<()> {
        let mut backend = self.inner.lock().unwrap();
        ensure_unlocked(&backend)?;
        // Clear only the auth secrets — the sudo password (D-026) survives
        // auth-method changes and is managed via set_sudo_password.
        clear_auth_locked(&mut backend, host_id)?;
        match auth {
            AuthInput::Password { value } => set_locked(&mut backend, &password_key(host_id), value)?,
            AuthInput::Key {
                passphrase: Some(p),
                ..
            } => set_locked(&mut backend, &passphrase_key(host_id), p)?,
            AuthInput::Key { passphrase: None, .. } => {}
        }
        Ok(())
    }

    pub fn get_password(&self, host_id: i64) -> AppResult<Option<String>> {
        self.get(&password_key(host_id))
    }

    pub fn get_passphrase(&self, host_id: i64) -> AppResult<Option<String>> {
        self.get(&passphrase_key(host_id))
    }

    pub fn get_sudo_password(&self, host_id: i64) -> AppResult<Option<String>> {
        self.get(&sudo_password_key(host_id))
    }

    /// Sets or clears the per-host sudo password (D-026). Independent of
    /// `apply_auth` because the sudo password outlives auth-method changes.
    pub fn set_sudo_password(&self, host_id: i64, value: Option<&str>) -> AppResult<()> {
        let mut backend = self.inner.lock().unwrap();
        ensure_unlocked(&backend)?;
        match value {
            Some(v) => set_locked(&mut backend, &sudo_password_key(host_id), v),
            None => match &mut *backend {
                Backend::Keyring => {
                    let _ = keyring_store::delete(&sudo_password_key(host_id));
                    Ok(())
                }
                Backend::File(fs) => fs.delete_prefix(&sudo_password_key(host_id)),
            },
        }
    }

    fn get(&self, key: &str) -> AppResult<Option<String>> {
        let backend = self.inner.lock().unwrap();
        ensure_unlocked(&backend)?;
        match &*backend {
            Backend::Keyring => keyring_store::get(key),
            Backend::File(fs) => fs.get(key),
        }
    }

    pub fn clear_host(&self, host_id: i64) -> AppResult<()> {
        let mut backend = self.inner.lock().unwrap();
        ensure_unlocked(&backend)?;
        clear_locked(&mut backend, host_id)
    }
}

fn ensure_unlocked(backend: &Backend) -> AppResult<()> {
    match backend {
        Backend::Keyring => Ok(()),
        Backend::File(fs) if fs.is_unlocked() => Ok(()),
        Backend::File(_) => Err(AppError::CredentialsLocked),
    }
}

fn set_locked(backend: &mut Backend, key: &str, value: &str) -> AppResult<()> {
    match backend {
        Backend::Keyring => keyring_store::set(key, value),
        Backend::File(fs) => fs.set(key, value),
    }
}

fn clear_locked(backend: &mut Backend, host_id: i64) -> AppResult<()> {
    match backend {
        Backend::Keyring => {
            let _ = keyring_store::delete(&password_key(host_id));
            let _ = keyring_store::delete(&passphrase_key(host_id));
            let _ = keyring_store::delete(&sudo_password_key(host_id));
            Ok(())
        }
        Backend::File(fs) => fs.delete_prefix(&host_prefix(host_id)),
    }
}

fn clear_auth_locked(backend: &mut Backend, host_id: i64) -> AppResult<()> {
    match backend {
        Backend::Keyring => {
            let _ = keyring_store::delete(&password_key(host_id));
            let _ = keyring_store::delete(&passphrase_key(host_id));
            Ok(())
        }
        Backend::File(fs) => {
            fs.delete_prefix(&password_key(host_id))?;
            fs.delete_prefix(&passphrase_key(host_id))
        }
    }
}

fn host_prefix(host_id: i64) -> String {
    format!("host:{host_id}:")
}

fn password_key(host_id: i64) -> String {
    format!("host:{host_id}:password")
}

fn passphrase_key(host_id: i64) -> String {
    format!("host:{host_id}:passphrase")
}

fn sudo_password_key(host_id: i64) -> String {
    format!("host:{host_id}:sudo_password")
}
