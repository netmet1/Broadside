use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("host not found: id={0}")]
    HostNotFound(i64),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("app state error: {0}")]
    State(String),
    #[error("credentials locked: master password required")]
    CredentialsLocked,
    #[error("admin lock is on: unlock in Settings → Security to change this")]
    AdminLocked,
    #[error("credentials error: {0}")]
    Credentials(String),
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("ssh error: {0}")]
    Ssh(String),
    #[error("destructive command requires confirmation (rules: {0})")]
    DestructiveBlocked(String),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("local filesystem error: {0}")]
    LocalFs(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        let kind = match self {
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::HostNotFound(_) => "host_not_found",
            AppError::InvalidInput(_) => "invalid_input",
            AppError::State(_) => "state",
            AppError::CredentialsLocked => "credentials_locked",
            AppError::AdminLocked => "admin_locked",
            AppError::Credentials(_) => "credentials",
            AppError::Serde(_) => "serde",
            AppError::Ssh(_) => "ssh",
            AppError::DestructiveBlocked(_) => "destructive_blocked",
            AppError::Crypto(_) => "crypto",
            AppError::LocalFs(_) => "local_fs",
        };
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
