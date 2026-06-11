//! Integration tests for the SSH TOFU layer against a real OpenSSH server
//! in docker (linuxserver/openssh-server, Linux containers).
//!
//! Ignored by default: GitHub's Windows runners can't run Linux containers,
//! so this suite is a LOCAL pre-merge gate (D-035). Run with:
//!
//!     cargo test --test ssh_tofu -- --ignored --test-threads=1
//!
//! Requires docker with Linux containers on PATH.

use std::process::Command;
use std::time::{Duration, Instant};

use omniterminal_lib::ssh::{probe, AuthMethod, ProbeResult};

const IMAGE: &str = "lscr.io/linuxserver/openssh-server:latest";
const USER: &str = "testuser";
const PASSWORD: &str = "testpass-123";

struct Fixture {
    container_id: String,
    port: u16,
}

impl Fixture {
    fn start() -> Fixture {
        let out = Command::new("docker")
            .args([
                "run",
                "-d",
                "--rm",
                "-p",
                "127.0.0.1:0:2222",
                "-e",
                &format!("USER_NAME={USER}"),
                "-e",
                &format!("USER_PASSWORD={PASSWORD}"),
                "-e",
                "PASSWORD_ACCESS=true",
                IMAGE,
            ])
            .output()
            .expect("docker run failed to spawn");
        assert!(
            out.status.success(),
            "docker run failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let container_id = String::from_utf8_lossy(&out.stdout).trim().to_string();

        let port_out = Command::new("docker")
            .args(["port", &container_id, "2222/tcp"])
            .output()
            .expect("docker port failed");
        let mapping = String::from_utf8_lossy(&port_out.stdout);
        let port: u16 = mapping
            .lines()
            .next()
            .and_then(|l| l.rsplit(':').next())
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or_else(|| panic!("unparseable docker port output: {mapping}"));

        let fixture = Fixture { container_id, port };
        fixture.wait_ready();
        fixture
    }

    /// Waits until sshd inside the container answers with its banner.
    fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(stream) = std::net::TcpStream::connect(("127.0.0.1", self.port)) {
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buf = [0u8; 4];
                use std::io::Read;
                let mut s = stream;
                if s.read_exact(&mut buf).is_ok() && &buf == b"SSH-" {
                    return;
                }
            }
            assert!(
                Instant::now() < deadline,
                "fixture sshd not ready after 60s (container {})",
                self.container_id
            );
            std::thread::sleep(Duration::from_millis(500));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["stop", "-t", "1", &self.container_id])
            .output();
    }
}

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
