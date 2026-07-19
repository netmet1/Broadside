//! Integration tests for interactive PTY sessions against a real OpenSSH
//! server in docker. Ignored by default — local pre-merge gate (D-035).
//!
//!     cargo test --test ssh_pty -- --ignored --test-threads=1

mod common;

use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use common::{Fixture, PASSWORD, USER};
use broadside_lib::ssh::pty::{
    open, PtyBlock, PtyClosed, PtyData, PtyEvents, PtyState, SudoInjected,
};
use broadside_lib::ssh::{probe, AuthMethod, ProbeResult};
use tokio::sync::mpsc;

enum Event {
    Data(PtyData),
    Closed(PtyClosed),
    Block(PtyBlock),
}

struct ChannelEvents(mpsc::UnboundedSender<Event>);

impl PtyEvents for ChannelEvents {
    fn data(&self, payload: PtyData) {
        let _ = self.0.send(Event::Data(payload));
    }
    fn closed(&self, payload: PtyClosed) {
        let _ = self.0.send(Event::Closed(payload));
    }
    fn block(&self, payload: PtyBlock) {
        let _ = self.0.send(Event::Block(payload));
    }
    fn sudo_injected(&self, _payload: SudoInjected) {}
    fn sudo_rejected(&self, _payload: SudoInjected) {}
}

async fn trust(fx: &Fixture) -> String {
    let first = probe(
        "127.0.0.1",
        fx.port,
        USER,
        vec![],
        AuthMethod::Password(PASSWORD.to_string()),
    )
    .await
    .unwrap();
    match first {
        ProbeResult::UnknownKey { key } => key.fingerprint_sha256,
        other => panic!("expected UnknownKey on first contact, got {other:?}"),
    }
}

/// Collects decoded output until `needle` appears or the timeout elapses.
async fn read_until(
    rx: &mut mpsc::UnboundedReceiver<Event>,
    needle: &str,
    timeout: Duration,
) -> String {
    let mut buffer = String::new();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(Event::Data(d))) => {
                buffer.push_str(&String::from_utf8_lossy(&B64.decode(&d.data_b64).unwrap()));
                if buffer.contains(needle) {
                    return buffer;
                }
            }
            Ok(Some(Event::Block(_))) => {} // MultiTerminal blocks: not under test here
            Ok(Some(Event::Closed(_))) | Ok(None) => {
                panic!("session closed before {needle:?} appeared; got: {buffer}")
            }
            Err(_) => panic!("timed out waiting for {needle:?}; got: {buffer}"),
        }
    }
}

/// Drains events until a [`PtyBlock`] whose joined output lines contain
/// `needle` arrives (or the timeout elapses). Returns that block.
async fn read_block_until(
    rx: &mut mpsc::UnboundedReceiver<Event>,
    needle: &str,
    timeout: Duration,
) -> PtyBlock {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(Event::Block(b))) if b.block.lines.join("\n").contains(needle) => return b,
            Ok(Some(Event::Block(_))) | Ok(Some(Event::Data(_))) => {}
            Ok(Some(Event::Closed(_))) | Ok(None) => {
                panic!("session closed before a block containing {needle:?} arrived")
            }
            Err(_) => panic!("timed out waiting for a block containing {needle:?}"),
        }
    }
}

#[tokio::test]
#[ignore]
async fn pty_shell_round_trip_and_close() {
    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let state = PtyState::default();

    let result = open(
        ChannelEvents(tx),
        &state,
        "test-session".into(),
        "test-host",
        "127.0.0.1",
        fx.port,
        USER,
        vec![fp],
        AuthMethod::Password(PASSWORD.to_string()),
        None,
        80,
        24,
    )
    .await
    .unwrap();
    assert!(
        matches!(result, broadside_lib::ssh::pty::PtyOpenResult::Opened { .. }),
        "expected Opened, got {result:?}"
    );

    // Shell prompt arrives, then our command echoes back through the PTY.
    // $((6*7)) proves the shell evaluated it (output not just our keystrokes).
    state
        .write("test-session", b"echo result-$((6*7))\n")
        .unwrap();
    let output = read_until(&mut rx, "result-42", Duration::from_secs(20)).await;
    assert!(output.contains("result-42"), "output: {output}");

    // Resize must not kill the session.
    state.resize("test-session", 120, 40).unwrap();
    state.write("test-session", b"echo after-resize\n").unwrap();
    read_until(&mut rx, "after-resize", Duration::from_secs(10)).await;

    // Close → closed event arrives and the session deregisters.
    state.close("test-session").unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(Event::Closed(_))) | Ok(None) => break,
            Ok(Some(Event::Data(_))) | Ok(Some(Event::Block(_))) => continue,
            Err(_) => panic!("no closed event after close()"),
        }
    }
    assert!(
        state.write("test-session", b"x").is_err(),
        "writes after close must fail fast"
    );
}

/// Two opens with the same session id (the React StrictMode double-mount
/// shape). The second open replaces the first; the replaced task must die
/// silently — no closed event, and crucially it must NOT deregister its
/// successor (the original bug: remove-by-id tore down the live session,
/// leaving a dead-looking terminal).
#[tokio::test]
#[ignore]
async fn pty_reopen_same_id_replaces_session() {
    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let state = PtyState::default();

    for _ in 0..2 {
        let result = open(
            ChannelEvents(tx.clone()),
            &state,
            "dup-session".into(),
            "test-host",
            "127.0.0.1",
            fx.port,
            USER,
            vec![fp.clone()],
            AuthMethod::Password(PASSWORD.to_string()),
            None,
            80,
            24,
        )
        .await
        .unwrap();
        assert!(
            matches!(result, broadside_lib::ssh::pty::PtyOpenResult::Opened { .. }),
            "expected Opened, got {result:?}"
        );
    }

    // The survivor must still be registered and answering. read_until panics
    // on any Closed event, which doubles as the no-ghost-close assertion.
    state
        .write("dup-session", b"echo alive-$((2+3))\n")
        .unwrap();
    let output = read_until(&mut rx, "alive-5", Duration::from_secs(20)).await;
    assert!(output.contains("alive-5"), "output: {output}");
}

#[tokio::test]
#[ignore]
async fn pty_remote_exit_emits_closed() {
    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let state = PtyState::default();

    open(
        ChannelEvents(tx),
        &state,
        "exit-session".into(),
        "test-host",
        "127.0.0.1",
        fx.port,
        USER,
        vec![fp],
        AuthMethod::Password(PASSWORD.to_string()),
        None,
        80,
        24,
    )
    .await
    .unwrap();

    state.write("exit-session", b"exit 5\n").unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(Event::Closed(c))) => {
                // linuxserver's sshd reports the shell's exit status.
                assert_eq!(c.exit_code, Some(5), "closed: {c:?}");
                break;
            }
            Ok(Some(Event::Data(_))) | Ok(Some(Event::Block(_))) => continue,
            Ok(None) => panic!("event channel dropped without closed event"),
            Err(_) => panic!("no closed event after remote exit"),
        }
    }
}

/// End-to-end MultiTerminal block pipeline (D-061): real bash + the OSC 133
/// shell integration we ship + the `omni` VT parser must produce a clean,
/// completion-delimited block (command text, output lines, exit code) for a
/// normal command, and flag a full-screen app as interactive (no mirrored
/// output). Drives `bash` explicitly so the result is shell-deterministic
/// regardless of the fixture's default login shell.
#[tokio::test]
#[ignore]
async fn pty_omni_blocks_from_bash() {
    use broadside_lib::omni::{shell_integration_command, Interactivity};

    let fx = Fixture::start();
    let fp = trust(&fx).await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let state = PtyState::default();

    open(
        ChannelEvents(tx),
        &state,
        "omni-session".into(),
        "test-host",
        "127.0.0.1",
        fx.port,
        USER,
        vec![fp],
        AuthMethod::Password(PASSWORD.to_string()),
        None,
        80,
        24,
    )
    .await
    .unwrap();

    // Replace whatever the default login shell is with bash, then install our
    // integration into it (auto-install in open() targeted the original shell).
    state.write("omni-session", b"exec bash\n").unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    state
        .write("omni-session", shell_integration_command().as_bytes())
        .unwrap();

    // 1) A normal command → one clean block with command text, output, exit 0.
    state
        .write("omni-session", b"echo result-$((6*7))\n")
        .unwrap();
    let block = read_block_until(&mut rx, "result-42", Duration::from_secs(20)).await;
    assert_eq!(block.block.interactivity, Interactivity::Normal);
    assert_eq!(block.block.exit_code, Some(0), "block: {:?}", block.block);
    assert!(
        block
            .block
            .command
            .as_deref()
            .unwrap_or("")
            .contains("echo result"),
        "captured command: {:?}",
        block.block.command
    );

    // 2) A non-zero final exit code is captured (output then a failing command).
    state
        .write("omni-session", b"echo failing-marker; false\n")
        .unwrap();
    let block = read_block_until(&mut rx, "failing-marker", Duration::from_secs(20)).await;
    assert_eq!(block.block.exit_code, Some(1), "block: {:?}", block.block);

    // 3) A full-screen app (alternate-screen) is flagged interactive with no
    // mirrored output. The alt-screen block has empty lines, so we can't find
    // it by output text — drain blocks until a sentinel command, capturing the
    // alt-screen block by its command text along the way.
    state
        .write("omni-session", b"printf '\\033[?1049hPAINT\\033[?1049l'\n")
        .unwrap();
    state.write("omni-session", b"echo altdone\n").unwrap();
    let mut alt_block: Option<PtyBlock> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(Event::Block(b))) => {
                if b.block.lines.iter().any(|l| l.contains("altdone")) {
                    break; // sentinel reached
                }
                if b.block.command.as_deref().unwrap_or("").contains("1049h") {
                    alt_block = Some(b);
                }
            }
            Ok(Some(Event::Data(_))) => {}
            Ok(Some(Event::Closed(_))) | Ok(None) => panic!("closed before altdone sentinel"),
            Err(_) => panic!("timed out before altdone sentinel"),
        }
    }
    let alt = alt_block.expect("the alt-screen command should have produced a block");
    assert_eq!(
        alt.block.interactivity,
        Interactivity::AltScreen,
        "alt-screen command should be interactive: {:?}",
        alt.block
    );
    assert!(
        alt.block.lines.is_empty(),
        "interactive block must not mirror output: {:?}",
        alt.block.lines
    );
}
