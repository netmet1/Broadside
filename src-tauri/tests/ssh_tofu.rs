//! Integration tests for the SSH TOFU layer against a real OpenSSH server
//! in docker (linuxserver/openssh-server, Linux containers).
//!
//! Ignored by default: GitHub's Windows runners can't run Linux containers,
//! so this suite is a LOCAL pre-merge gate (D-035). Run with:
//!
//!     cargo test --test ssh_tofu -- --ignored --test-threads=1
//!
//! Requires docker with Linux containers on PATH.

mod common;

use common::{Fixture, PASSWORD, USER};
use omniterminal_lib::ssh::{probe, AuthMethod, ProbeResult};

fn password_auth() -> AuthMethod {
    AuthMethod::Password(PASSWORD.to_string())
}

/// First contact with no stored fingerprint must surface the presented key
/// without connecting.
#[tokio::test]
#[ignore]
async fn first_connect_reports_unknown_key() {
    let fx = Fixture::start();
    let result = probe("127.0.0.1", fx.port, USER, vec![], password_auth())
        .await
        .unwrap();
    match result {
        ProbeResult::UnknownKey { key } => {
            assert!(key.fingerprint_sha256.starts_with("SHA256:"), "{key:?}");
            assert!(!key.public_key.is_empty());
            assert!(!key.key_type.is_empty());
        }
        other => panic!("expected UnknownKey, got {other:?}"),
    }
}

/// Accepting the key (TOFU) and reconnecting must authenticate.
#[tokio::test]
#[ignore]
async fn trust_then_connect_succeeds() {
    let fx = Fixture::start();
    let first = probe("127.0.0.1", fx.port, USER, vec![], password_auth())
        .await
        .unwrap();
    let fingerprint = match first {
        ProbeResult::UnknownKey { key } => key.fingerprint_sha256,
        other => panic!("expected UnknownKey, got {other:?}"),
    };
    let second = probe(
        "127.0.0.1",
        fx.port,
        USER,
        vec![fingerprint],
        password_auth(),
    )
    .await
    .unwrap();
    match second {
        ProbeResult::Ok { latency_ms } => assert!(latency_ms > 0),
        other => panic!("expected Ok, got {other:?}"),
    }
}

/// Wrong password against a trusted key must be AuthFailed, not a key issue.
#[tokio::test]
#[ignore]
async fn wrong_password_reports_auth_failed() {
    let fx = Fixture::start();
    let first = probe("127.0.0.1", fx.port, USER, vec![], password_auth())
        .await
        .unwrap();
    let fingerprint = match first {
        ProbeResult::UnknownKey { key } => key.fingerprint_sha256,
        other => panic!("expected UnknownKey, got {other:?}"),
    };
    let result = probe(
        "127.0.0.1",
        fx.port,
        USER,
        vec![fingerprint],
        AuthMethod::Password("wrong-password".into()),
    )
    .await
    .unwrap();
    assert!(
        matches!(result, ProbeResult::AuthFailed { .. }),
        "expected AuthFailed, got {result:?}"
    );
}

/// A server presenting a different key than the stored fingerprint must be
/// reported as a mismatch (MITM signature) and refused.
#[tokio::test]
#[ignore]
async fn changed_server_key_reports_mismatch() {
    // Two independent containers generate distinct host keys; pointing the
    // fingerprint stored from A at B simulates a key change on the endpoint.
    let fx_a = Fixture::start();
    let fx_b = Fixture::start();

    let first = probe("127.0.0.1", fx_a.port, USER, vec![], password_auth())
        .await
        .unwrap();
    let fp_a = match first {
        ProbeResult::UnknownKey { key } => key.fingerprint_sha256,
        other => panic!("expected UnknownKey, got {other:?}"),
    };

    let result = probe("127.0.0.1", fx_b.port, USER, vec![fp_a.clone()], password_auth())
        .await
        .unwrap();
    match result {
        ProbeResult::KeyMismatch {
            stored_fingerprint,
            presented,
        } => {
            assert_eq!(stored_fingerprint, fp_a);
            assert_ne!(presented.fingerprint_sha256, fp_a);
        }
        other => panic!("expected KeyMismatch, got {other:?}"),
    }
}

/// Nothing listening on the port must come back Unreachable quickly.
#[tokio::test]
#[ignore]
async fn closed_port_reports_unreachable() {
    // Port 9 (discard) is virtually never bound on a dev machine.
    let result = probe("127.0.0.1", 9, USER, vec![], password_auth())
        .await
        .unwrap();
    assert!(
        matches!(result, ProbeResult::Unreachable { .. }),
        "expected Unreachable, got {result:?}"
    );
}
