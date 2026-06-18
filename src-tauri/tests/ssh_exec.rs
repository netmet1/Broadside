//! Integration tests for broadcast exec (D-002/D-004) against a real
//! OpenSSH server in docker. Ignored by default — local pre-merge gate
//! (D-035). Run with:
//!
//!     cargo test --test ssh_exec -- --ignored --test-threads=1

mod common;

use std::time::Duration;

use common::{Fixture, PASSWORD, USER};
use broadside_lib::ssh::exec::{exec, ExecResult};
use broadside_lib::ssh::{probe, AuthMethod, ProbeResult};

fn password_auth() -> AuthMethod {
    AuthMethod::Password(PASSWORD.to_string())
}

/// TOFU-accepts the fixture's key and returns the trusted fingerprint.
async fn trust(fx: &Fixture) -> String {
    let first = probe("127.0.0.1", fx.port, USER, vec![], password_auth())
        .await
        .unwrap();
    match first {
        ProbeResult::UnknownKey { key } => key.fingerprint_sha256,
        other => panic!("expected UnknownKey on first contact, got {other:?}"),
    }
}

#[tokio::test]
#[ignore]
async fn exec_captures_stdout_stderr_and_exit_code() {
    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let result = exec(
        "127.0.0.1",
        fx.port,
        USER,
        vec![fp],
        password_auth(),
        "echo out-line; echo err-line 1>&2; exit 7",
        None,
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    match result {
        ExecResult::Completed {
            exit_code,
            stdout,
            stderr,
            timed_out,
            ..
        } => {
            assert_eq!(exit_code, Some(7));
            assert!(stdout.contains("out-line"), "stdout: {stdout:?}");
            assert!(stderr.contains("err-line"), "stderr: {stderr:?}");
            assert!(!timed_out);
        }
        other => panic!("expected Completed, got {other:?}"),
    }
}

#[tokio::test]
#[ignore]
async fn exec_timeout_preserves_partial_output() {
    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let result = exec(
        "127.0.0.1",
        fx.port,
        USER,
        vec![fp],
        password_auth(),
        "echo started; sleep 60; echo never",
        None,
        Duration::from_secs(4),
    )
    .await
    .unwrap();
    match result {
        ExecResult::Completed {
            exit_code,
            stdout,
            timed_out,
            duration_ms,
            ..
        } => {
            assert!(timed_out, "expected timeout");
            assert!(stdout.contains("started"), "partial stdout lost: {stdout:?}");
            assert!(!stdout.contains("never"));
            assert_eq!(exit_code, None);
            assert!(duration_ms < 30_000, "should cut off near the 4s timeout");
        }
        other => panic!("expected Completed(timed_out), got {other:?}"),
    }
}

#[tokio::test]
#[ignore]
async fn exec_stdin_payload_reaches_command() {
    // `cat` echoes stdin — proves the sudo -S password piping transport
    // (D-026) delivers the payload and EOF cleanly.
    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let result = exec(
        "127.0.0.1",
        fx.port,
        USER,
        vec![fp],
        password_auth(),
        "cat",
        Some("piped-secret\n".to_string()),
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    match result {
        ExecResult::Completed {
            exit_code, stdout, ..
        } => {
            assert_eq!(exit_code, Some(0));
            assert_eq!(stdout, "piped-secret\n");
        }
        other => panic!("expected Completed, got {other:?}"),
    }
}

#[tokio::test]
#[ignore]
async fn exec_without_trusted_key_reports_unknown_key() {
    let fx = Fixture::start();
    let result = exec(
        "127.0.0.1",
        fx.port,
        USER,
        vec![],
        password_auth(),
        "uptime",
        None,
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    assert!(
        matches!(result, ExecResult::UnknownKey { .. }),
        "expected UnknownKey, got {result:?}"
    );
}

#[tokio::test]
#[ignore]
async fn exec_command_reading_stdin_gets_eof() {
    // Without an explicit stdin payload the channel still sends EOF, so
    // stdin-reading commands terminate instead of hanging until timeout.
    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let result = exec(
        "127.0.0.1",
        fx.port,
        USER,
        vec![fp],
        password_auth(),
        "wc -l",
        None,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    match result {
        ExecResult::Completed {
            exit_code,
            timed_out,
            ..
        } => {
            assert!(!timed_out, "wc -l hung on stdin — EOF not delivered");
            assert_eq!(exit_code, Some(0));
        }
        other => panic!("expected Completed, got {other:?}"),
    }
}
