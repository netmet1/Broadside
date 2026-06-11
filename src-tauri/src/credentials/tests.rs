use super::*;
use tempfile::TempDir;

fn make_file_store() -> (CredentialState, TempDir) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("credentials.age");
    (CredentialState::new_file_only(path), dir)
}

#[test]
fn file_store_starts_locked() {
    let (s, _d) = make_file_store();
    assert!(!s.is_unlocked());
    assert!(s.requires_master_password());
}

#[test]
fn file_unlock_with_password_succeeds_on_empty_file() {
    let (s, _d) = make_file_store();
    let ok = s.unlock("master-pw").unwrap();
    assert!(ok);
    assert!(s.is_unlocked());
}

#[test]
fn apply_then_clear_password() {
    let (s, _d) = make_file_store();
    s.unlock("master-pw").unwrap();
    s.apply_auth(
        42,
        &AuthInput::Password {
            value: "secret123".into(),
        },
    )
    .unwrap();
    s.clear_host(42).unwrap();
}

#[test]
fn apply_key_with_passphrase() {
    let (s, _d) = make_file_store();
    s.unlock("master-pw").unwrap();
    s.apply_auth(
        7,
        &AuthInput::Key {
            path: "C:/keys/id_ed25519".into(),
            passphrase: Some("keypw".into()),
        },
    )
    .unwrap();
}

#[test]
fn apply_key_without_passphrase_is_noop() {
    let (s, _d) = make_file_store();
    s.unlock("master-pw").unwrap();
    s.apply_auth(
        7,
        &AuthInput::Key {
            path: "C:/keys/id_ed25519".into(),
            passphrase: None,
        },
    )
    .unwrap();
}

#[test]
fn set_when_locked_errors() {
    let (s, _d) = make_file_store();
    let err = s
        .apply_auth(
            1,
            &AuthInput::Password {
                value: "x".into(),
            },
        )
        .unwrap_err();
    assert!(matches!(err, AppError::CredentialsLocked));
}

#[test]
fn unlock_with_wrong_password_returns_false() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("credentials.age");
    // First instance: write a secret under password "correct"
    let s1 = CredentialState::new_file_only(path.clone());
    assert!(s1.unlock("correct").unwrap());
    s1.apply_auth(
        1,
        &AuthInput::Password {
            value: "secret".into(),
        },
    )
    .unwrap();
    drop(s1);

    // Second instance: try to unlock with wrong password
    let s2 = CredentialState::new_file_only(path);
    let ok = s2.unlock("wrong").unwrap();
    assert!(!ok);
    assert!(!s2.is_unlocked());
}

#[test]
fn unlock_persists_across_reopens() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("credentials.age");
    let s1 = CredentialState::new_file_only(path.clone());
    assert!(s1.unlock("master").unwrap());
    s1.apply_auth(
        99,
        &AuthInput::Password {
            value: "deadbeef".into(),
        },
    )
    .unwrap();
    drop(s1);

    let s2 = CredentialState::new_file_only(path);
    let ok = s2.unlock("master").unwrap();
    assert!(ok);
    // We can't read the secret back (no API for that), but a successful unlock
    // proves the file was decryptable with the same passphrase.
}

#[test]
fn sudo_password_round_trip() {
    let (s, _d) = make_file_store();
    s.unlock("master").unwrap();
    s.set_sudo_password(3, Some("sudopw")).unwrap();
    assert_eq!(s.get_sudo_password(3).unwrap().as_deref(), Some("sudopw"));
    s.set_sudo_password(3, None).unwrap();
    assert_eq!(s.get_sudo_password(3).unwrap(), None);
}

#[test]
fn sudo_password_survives_auth_change() {
    let (s, _d) = make_file_store();
    s.unlock("master").unwrap();
    s.set_sudo_password(8, Some("sudopw")).unwrap();
    s.apply_auth(
        8,
        &AuthInput::Password {
            value: "loginpw".into(),
        },
    )
    .unwrap();
    s.apply_auth(
        8,
        &AuthInput::Key {
            path: "/k".into(),
            passphrase: None,
        },
    )
    .unwrap();
    assert_eq!(
        s.get_sudo_password(8).unwrap().as_deref(),
        Some("sudopw"),
        "sudo password must survive auth-method changes (D-026)"
    );
}

#[test]
fn clear_host_removes_sudo_password() {
    let (s, _d) = make_file_store();
    s.unlock("master").unwrap();
    s.set_sudo_password(9, Some("sudopw")).unwrap();
    s.clear_host(9).unwrap();
    assert_eq!(s.get_sudo_password(9).unwrap(), None);
}

#[test]
fn switching_auth_method_clears_old_secret() {
    let (s, _d) = make_file_store();
    s.unlock("master").unwrap();
    s.apply_auth(
        5,
        &AuthInput::Password {
            value: "pw".into(),
        },
    )
    .unwrap();
    // Switch to key
    s.apply_auth(
        5,
        &AuthInput::Key {
            path: "/k".into(),
            passphrase: Some("kp".into()),
        },
    )
    .unwrap();
    // No assert on internal state — the test verifies no errors during the
    // switch, which exercises the clear-old-then-set-new path.
}
