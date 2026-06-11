//! Passphrase-based age encryption shared by the credential file store
//! (PR#2) and .otlog session files (PR#7, D-010).

use std::io::{Read, Write};

use age::secrecy::SecretString;

use crate::error::{AppError, AppResult};

/// age binary header — used to sniff whether a file needs a passphrase.
pub const AGE_MAGIC: &[u8] = b"age-encryption.org/v1";

pub fn is_age_encrypted(bytes: &[u8]) -> bool {
    bytes.starts_with(AGE_MAGIC)
}

pub fn encrypt(plaintext: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let encryptor =
        age::Encryptor::with_user_passphrase(SecretString::from(passphrase.to_string()));
    let mut output = vec![];
    let mut writer = encryptor
        .wrap_output(&mut output)
        .map_err(|e| AppError::Crypto(format!("age encrypt init: {e}")))?;
    writer
        .write_all(plaintext)
        .map_err(|e| AppError::Crypto(format!("age write: {e}")))?;
    writer
        .finish()
        .map_err(|e| AppError::Crypto(format!("age finish: {e}")))?;
    Ok(output)
}

/// Wrong passphrases surface as `AppError::Crypto` — callers that need a
/// boolean "wrong password" treat that variant as such.
pub fn decrypt(encrypted: &[u8], passphrase: &str) -> AppResult<Vec<u8>> {
    let decryptor = age::Decryptor::new(encrypted)
        .map_err(|e| AppError::Crypto(format!("age decryptor: {e}")))?;
    let identity = age::scrypt::Identity::new(SecretString::from(passphrase.to_string()));
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|e| AppError::Crypto(format!("age decrypt: {e}")))?;
    let mut output = vec![];
    reader
        .read_to_end(&mut output)
        .map_err(|e| AppError::Crypto(format!("age read: {e}")))?;
    Ok(output)
}
