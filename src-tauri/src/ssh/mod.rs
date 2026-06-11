use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult, Handle};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub mod exec;
pub mod pty;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Key the server presented during the handshake, captured by the handler
/// regardless of whether the connection was allowed to proceed.
#[derive(Debug, Clone, Serialize)]
pub struct PresentedKey {
    pub key_type: String,
    pub public_key: String,
    pub fingerprint_sha256: String,
}

/// What the caller should do about the server key, decided against the
/// trusted fingerprint (if any) the caller passed in.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ProbeResult {
    /// Key trusted (or no auth requested) and authentication succeeded.
    Ok { latency_ms: u64 },
    /// No stored key for this endpoint — TOFU prompt needed.
    UnknownKey { key: PresentedKey },
    /// Stored key differs from the presented one — hard warning.
    KeyMismatch {
        stored_fingerprint: String,
        presented: PresentedKey,
    },
    AuthFailed { message: String },
    Unreachable { message: String },
    /// Host has no stored credentials; probe was not attempted.
    NoCredentials,
}

/// Connection attempt outcomes short of an authenticated session. Shared by
/// probe (test connection) and exec (broadcast) so both report key/auth
/// trouble identically.
#[derive(Debug, Clone)]
pub enum ConnectFailure {
    UnknownKey {
        key: PresentedKey,
    },
    KeyMismatch {
        stored_fingerprint: String,
        presented: PresentedKey,
    },
    AuthFailed {
        message: String,
    },
    Unreachable {
        message: String,
    },
}

pub enum AuthMethod {
    Password(String),
    Key {
        path: String,
        passphrase: Option<String>,
    },
}

pub(crate) struct TofuHandler {
    /// Fingerprints we already trust for this endpoint (one per key type).
    trusted_fingerprints: Vec<String>,
    /// Records what the server actually presented.
    seen: Arc<Mutex<Option<PresentedKey>>>,
}

impl client::Handler for TofuHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let presented = PresentedKey {
            key_type: server_public_key.algorithm().to_string(),
            public_key: server_public_key.to_openssh().unwrap_or_default(),
            fingerprint_sha256: fingerprint.clone(),
        };
        *self.seen.lock().unwrap() = Some(presented);
        Ok(self.trusted_fingerprints.contains(&fingerprint))
    }
}

/// TOFU-verified connect + authenticate. `Ok(Err(_))` are expected outcomes
/// (unknown key, wrong password, host down); `Err(_)` are our own failures.
pub(crate) async fn connect_and_auth(
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
) -> AppResult<Result<Handle<TofuHandler>, ConnectFailure>> {
    let seen: Arc<Mutex<Option<PresentedKey>>> = Arc::new(Mutex::new(None));
    let handler = TofuHandler {
        trusted_fingerprints: trusted_fingerprints.clone(),
        seen: seen.clone(),
    };
    let config = Arc::new(client::Config::default());

    let connect = client::connect(config, (hostname, port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
        Err(_) => {
            return Ok(Err(ConnectFailure::Unreachable {
                message: format!("connection timed out after {}s", CONNECT_TIMEOUT.as_secs()),
            }))
        }
        Ok(Err(russh::Error::UnknownKey)) => {
            // Handler rejected the key; classify from what it recorded.
            let presented = seen.lock().unwrap().clone();
            return Ok(Err(match presented {
                Some(p) if trusted_fingerprints.is_empty() => {
                    ConnectFailure::UnknownKey { key: p }
                }
                Some(p) => ConnectFailure::KeyMismatch {
                    stored_fingerprint: trusted_fingerprints.join(", "),
                    presented: p,
                },
                // Rejected before the handler saw a key — shouldn't happen.
                None => ConnectFailure::Unreachable {
                    message: "server key rejected before capture".into(),
                },
            }));
        }
        Ok(Err(e)) => {
            return Ok(Err(ConnectFailure::Unreachable {
                message: e.to_string(),
            }))
        }
        Ok(Ok(h)) => h,
    };

    let auth_result =
        tokio::time::timeout(AUTH_TIMEOUT, authenticate(&mut handle, username, auth)).await;

    match auth_result {
        Err(_) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(Err(ConnectFailure::AuthFailed {
                message: format!("authentication timed out after {}s", AUTH_TIMEOUT.as_secs()),
            }))
        }
        Ok(Err(e)) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Err(e)
        }
        Ok(Ok(AuthResult::Success)) => Ok(Ok(handle)),
        Ok(Ok(AuthResult::Failure { .. })) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(Err(ConnectFailure::AuthFailed {
                message: "server rejected the credentials".into(),
            }))
        }
    }
}

/// Connects to hostname:port, runs TOFU key verification against
/// `trusted_fingerprints`, and (when the key checks out) attempts auth.
pub async fn probe(
    hostname: &str,
    port: u16,
    username: &str,
    trusted_fingerprints: Vec<String>,
    auth: AuthMethod,
) -> AppResult<ProbeResult> {
    let started = Instant::now();
    match connect_and_auth(hostname, port, username, trusted_fingerprints, auth).await? {
        Ok(handle) => {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(ProbeResult::Ok {
                latency_ms: started.elapsed().as_millis() as u64,
            })
        }
        Err(failure) => Ok(failure.into()),
    }
}

impl From<ConnectFailure> for ProbeResult {
    fn from(f: ConnectFailure) -> Self {
        match f {
            ConnectFailure::UnknownKey { key } => ProbeResult::UnknownKey { key },
            ConnectFailure::KeyMismatch {
                stored_fingerprint,
                presented,
            } => ProbeResult::KeyMismatch {
                stored_fingerprint,
                presented,
            },
            ConnectFailure::AuthFailed { message } => ProbeResult::AuthFailed { message },
            ConnectFailure::Unreachable { message } => ProbeResult::Unreachable { message },
        }
    }
}

async fn authenticate(
    handle: &mut Handle<TofuHandler>,
    username: &str,
    auth: AuthMethod,
) -> AppResult<AuthResult> {
    match auth {
        AuthMethod::Password(password) => handle
            .authenticate_password(username, password)
            .await
            .map_err(|e| AppError::Ssh(format!("password auth: {e}"))),
        AuthMethod::Key { path, passphrase } => {
            let key = load_secret_key(&path, passphrase.as_deref())
                .map_err(|e| AppError::Ssh(format!("load key {path}: {e}")))?;
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| AppError::Ssh(format!("rsa hash negotiation: {e}")))?
                .flatten();
            handle
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| AppError::Ssh(format!("publickey auth: {e}")))
        }
    }
}
