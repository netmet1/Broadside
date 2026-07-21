//! Engine tests. [`PtyLink`] is a pair of channels, so the whole expect/send
//! state machine runs against a scripted fake host: no SSH, no live shell.
//!
//! Every test runs on a paused clock (`start_paused`): timeouts and settle
//! windows resolve instantly and deterministically. Responses are queued into
//! the data channel *before* the engine starts, which is also the real
//! ordering (a host's output routinely lands while the previous step is still
//! finishing), and it means no test races the engine to feed it.

use std::sync::{Arc, Mutex};

use super::config::{MatchBranch, SeqStep, SequenceConfig, SkillParam, TimeoutAction, STOP};
use super::state::Ctl;
use super::*;

#[derive(Default)]
struct Collected {
    progress: Vec<SkillProgress>,
    paused: Vec<SkillPaused>,
    done: Vec<SkillDone>,
}

#[derive(Default)]
struct CollectEvents(Mutex<Collected>);

impl SkillEvents for CollectEvents {
    fn progress(&self, payload: SkillProgress) {
        self.0.lock().unwrap().progress.push(payload);
    }
    fn paused(&self, payload: SkillPaused) {
        self.0.lock().unwrap().paused.push(payload);
    }
    fn done(&self, payload: SkillDone) {
        self.0.lock().unwrap().done.push(payload);
    }
}

impl CollectEvents {
    fn paused_reasons(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .paused
            .iter()
            .map(|p| p.reason.clone())
            .collect()
    }
    fn phases(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .progress
            .iter()
            .map(|p| p.phase.clone())
            .collect()
    }
}

/// The test's side of the fake host.
struct Host {
    data: mpsc::UnboundedSender<TapMsg>,
    ctl: mpsc::UnboundedSender<Ctl>,
    writes: Arc<Mutex<Vec<String>>>,
    events: Arc<CollectEvents>,
}

impl Host {
    /// Queues output as if the host had printed it.
    fn say(&self, text: &str) {
        self.data
            .send(TapMsg::Data(text.as_bytes().to_vec()))
            .unwrap();
    }
    fn close(&self) {
        self.data.send(TapMsg::Closed).unwrap();
    }
    fn writes(&self) -> Vec<String> {
        self.writes.lock().unwrap().clone()
    }
    /// Everything the engine has typed, joined, for "did it send X at all".
    fn typed(&self) -> String {
        self.writes().join("")
    }
}

fn harness() -> (Engine<CollectEvents>, Host) {
    let (data_tx, data_rx) = mpsc::unbounded_channel();
    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
    let writes = Arc::new(Mutex::new(Vec::new()));
    let sink = writes.clone();
    let link = PtyLink {
        rx: data_rx,
        write: Box::new(move |b: &[u8]| {
            sink.lock()
                .unwrap()
                .push(String::from_utf8_lossy(b).to_string());
            Ok(())
        }),
    };
    let events = Arc::new(CollectEvents::default());
    let engine = Engine::new(
        link,
        ctl_rx,
        events.clone(),
        HostMeta {
            run_id: "run1".into(),
            host_id: 7,
            label: "web01".into(),
            session_id: "sess-7".into(),
        },
    );
    (
        engine,
        Host {
            data: data_tx,
            ctl: ctl_tx,
            writes,
            events,
        },
    )
}

fn run_step(id: &str, command: &str, on_success: &str, on_failure: &str) -> SeqStep {
    SeqStep::Run {
        id: id.into(),
        command: command.into(),
        interactive: false,
        timeout_secs: Some(30),
        on_timeout: TimeoutAction::Fail,
        on_success: on_success.into(),
        on_failure: on_failure.into(),
        r#match: None,
    }
}

/// Enum variants don't take functional-record-update syntax, so these tweak a
/// built step instead.
///
/// Note for anyone adding tests here: a step that pauses with nobody to resume
/// it waits forever, exactly as it would in the app. Any test that lets a step
/// time out must either set `Fail` or spawn a controller.
fn on_timeout(mut step: SeqStep, action: TimeoutAction) -> SeqStep {
    match &mut step {
        SeqStep::Run { on_timeout, .. } | SeqStep::Expect { on_timeout, .. } => {
            *on_timeout = action
        }
        SeqStep::Send { .. } | SeqStep::Wait { .. } => {}
    }
    step
}

fn interactive(mut step: SeqStep) -> SeqStep {
    if let SeqStep::Run { interactive, .. } = &mut step {
        *interactive = true;
    }
    step
}

fn expect_step(id: &str, pattern: &str, send: Option<&str>, on_match: &str) -> SeqStep {
    SeqStep::Expect {
        id: id.into(),
        pattern: pattern.into(),
        send_on_match: send.map(str::to_string),
        timeout_secs: Some(30),
        on_timeout: TimeoutAction::Pause,
        on_match: on_match.into(),
    }
}

fn cfg(steps: Vec<SeqStep>) -> SequenceConfig {
    let start = steps[0].id().to_string();
    SequenceConfig {
        params: vec![],
        start_step_id: start,
        steps,
        allow_transfer: false,
    }
}

/// The echo a real shell sends back for a sentinel-wrapped command.
fn echo_of(command: &str) -> String {
    format!(" {command}; printf '__bsdone_%s__\\n' \"$?\"\r\n")
}

// ---------------------------------------------------------------- run steps

#[tokio::test(start_paused = true)]
async fn run_step_takes_the_success_branch_on_exit_zero() {
    let (mut engine, host) = harness();
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    host.say(&echo_of("uptime"));
    host.say("14:02 up 9 days\r\n__bsdone_0__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    // The command went out sentinel-wrapped.
    assert!(host.typed().contains(r#"uptime; printf '__bsdone_%s__\n' "$?""#));
}

#[tokio::test(start_paused = true)]
async fn run_step_takes_the_failure_branch_on_nonzero_exit() {
    // The not-installed case: exit 127 → failure branch.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "htop", STOP, "b"),
        run_step("b", "echo recovering", STOP, STOP),
    ]);
    host.say(&echo_of("htop"));
    host.say("bash: htop: command not found\r\n__bsdone_127__\r\n");
    host.say(&echo_of("echo recovering"));
    host.say("recovering\r\n__bsdone_0__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    // It really did route through the recovery step.
    assert!(host.typed().contains("echo recovering"));
}

#[tokio::test(start_paused = true)]
async fn command_echo_is_never_mistaken_for_the_result() {
    // The echo carries `__bsdone_%s__`. If the engine matched that, the step
    // would "finish", and take its success branch, before the command had
    // even run.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "sleep 600", "too-early", STOP),
        run_step("too-early", "should not run", STOP, STOP),
    ]);
    host.say(&echo_of("sleep 600"));
    // Only the echo ever arrives: the step must time out, not succeed.
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}"); // the timeout's failure branch is `stop`
    assert!(
        !host.typed().contains("should not run"),
        "the echo was read as a result"
    );
}

#[tokio::test(start_paused = true)]
async fn a_trailing_semicolon_does_not_break_the_wrapper() {
    let (mut engine, host) = harness();
    let c = cfg(vec![run_step("a", "ls ;", STOP, "fail")]);
    host.say("__bsdone_0__\r\n");
    engine.run_sequence(&c).await;
    assert!(host.typed().contains(r#"ls; printf"#), "{}", host.typed());
}

#[tokio::test(start_paused = true)]
async fn output_match_branch_outranks_the_exit_code() {
    let (mut engine, host) = harness();
    let mut step = run_step("a", "systemctl status app", "wrong", "wrong");
    if let SeqStep::Run { r#match, .. } = &mut step {
        *r#match = Some(MatchBranch {
            pattern: "active \\(running\\)".into(),
            if_match: STOP.into(),
            if_no_match: "wrong".into(),
        });
    }
    let c = cfg(vec![step, run_step("wrong", "true", STOP, STOP)]);
    // Exit 3 (systemctl's "not running") but the output says running: the
    // output test wins.
    host.say(&echo_of("systemctl status app"));
    host.say("   Active: active (running)\r\n__bsdone_3__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(!host.typed().contains("true"), "took the wrong branch");
}

#[tokio::test(start_paused = true)]
async fn output_match_ignores_the_commands_own_echo() {
    // `grep error` echoes "error" back. Matching the echo would take the
    // if_match branch on every run, whatever the file held.
    let (mut engine, host) = harness();
    let mut step = run_step("a", "grep error /var/log/app.log", "wrong", "wrong");
    if let SeqStep::Run { r#match, .. } = &mut step {
        *r#match = Some(MatchBranch {
            pattern: "error".into(),
            if_match: "wrong".into(),
            if_no_match: STOP.into(),
        });
    }
    let c = cfg(vec![step, run_step("wrong", "true", STOP, STOP)]);
    host.say(&echo_of("grep error /var/log/app.log"));
    host.say("__bsdone_1__\r\n"); // grep found nothing
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(!host.typed().contains("true"), "matched its own echo");
}

#[test]
fn command_output_strips_echo_and_marker() {
    let raw = format!(
        "{}real output\nmore output\n__bsdone_0__\n",
        echo_of("cat file").replace("\r\n", "\n")
    );
    assert_eq!(command_output(&raw), "real output\nmore output\n");
}

#[test]
fn command_output_survives_a_wrapped_echo() {
    // A long command wraps across tty lines; the cut must land after the echo's
    // last line, not its first.
    let raw = " apt update && apt -y upgrade; printf '__bsdone_%s__\\n' \n\"$?\"\nDone.\n__bsdone_0__\n";
    assert_eq!(command_output(raw), "Done.\n");
}

#[test]
fn command_output_of_a_silent_command_is_empty() {
    let raw = format!("{}__bsdone_0__\n", echo_of("true").replace("\r\n", "\n"));
    assert_eq!(command_output(&raw), "");
}

// ------------------------------------------------------- expect / send steps

#[tokio::test(start_paused = true)]
async fn expect_step_answers_an_interactive_prompt() {
    // The north-star: the program asks, the engine answers, the operator watches.
    let (mut engine, host) = harness();
    let c = cfg(vec![expect_step(
        "a",
        r"Do you want to continue\? \[Y/n\]",
        Some("y\n"),
        STOP,
    )]);
    host.say("Do you want to continue? [Y/n] ");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(host.typed(), "y\n");
}

#[tokio::test(start_paused = true)]
async fn an_authored_answer_reaches_the_host_as_a_real_newline() {
    // The C8 regression. Every other test here builds its steps with a real
    // "\n" in the Rust source, which is why they all passed while the feature
    // was broken: a step authored in the builder holds the two characters
    // `\` and `n`, and nothing unescaped them, so the prompt never submitted.
    // Go through prepare(), the way a real run does.
    let (mut engine, host) = harness();
    let authored = cfg(vec![expect_step(
        "a",
        r"\(y/n\)",
        Some(r"y\n"), // exactly what the builder stores
        STOP,
    )]);
    let c = prepare(&authored, &std::collections::HashMap::new()).unwrap();
    host.say("continue? (y/n) ");
    assert!(engine.run_sequence(&c).await.ok);
    assert_eq!(host.typed(), "y\n", "the answer was typed without an Enter");
}

#[tokio::test(start_paused = true)]
async fn an_authored_send_step_reaches_the_host_as_a_real_newline() {
    let (mut engine, host) = harness();
    let authored = cfg(vec![SeqStep::Send {
        id: "a".into(),
        input: r"q\n".into(),
        next: STOP.into(),
    }]);
    let c = prepare(&authored, &std::collections::HashMap::new()).unwrap();
    assert!(engine.run_sequence(&c).await.ok);
    assert_eq!(host.typed(), "q\n");
}

#[tokio::test(start_paused = true)]
async fn expect_matches_a_prompt_with_no_trailing_newline() {
    let (mut engine, host) = harness();
    let c = cfg(vec![expect_step("a", "join now\\?", Some("y\n"), STOP)]);
    host.say("join now? "); // no newline: a real prompt never sends one
    assert!(engine.run_sequence(&c).await.ok);
    assert_eq!(host.typed(), "y\n");
}

#[tokio::test(start_paused = true)]
async fn expect_matches_through_ansi_redraw_noise() {
    let (mut engine, host) = harness();
    let c = cfg(vec![expect_step("a", "^Ready$", None, STOP)]);
    // htop repaints one line in place, in colour, then settles.
    host.say("\x1b[33mAttempt 8: waiting\x1b[0m\rAttempt 9: waiting\r");
    host.say("\x1b[32mReady\x1b[0m\x1b[K\r\n");
    assert!(engine.run_sequence(&c).await.ok);
}

#[tokio::test(start_paused = true)]
async fn a_prompt_arriving_early_is_still_matched() {
    // It lands while the previous step is finishing; the expect step that
    // answers it starts afterwards. Consume-on-match is what saves this.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "htop", "b", "fail"),
        expect_step("b", "Restart nginx\\?", Some("y\n"), STOP),
    ]);
    host.say(&echo_of("htop"));
    host.say("working\r\n__bsdone_0__\r\nRestart nginx? (y/n) ");
    assert!(engine.run_sequence(&c).await.ok);
    assert!(host.typed().ends_with("y\n"));
}

#[tokio::test(start_paused = true)]
async fn matched_output_cannot_satisfy_a_later_step() {
    // Two identical prompts must each be answered once: the first match is
    // consumed, so it can't stand in for the second.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        expect_step("a", "\\(y/n\\)", Some("y\n"), "b"),
        expect_step("b", "\\(y/n\\)", Some("n\n"), STOP),
    ]);
    host.say("first? (y/n) ");
    host.say("\r\nsecond? (y/n) ");
    assert!(engine.run_sequence(&c).await.ok);
    assert_eq!(host.writes(), vec!["y\n", "n\n"]);
}

#[tokio::test(start_paused = true)]
async fn a_fixed_gap_separates_completed_steps() {
    // The 30ms breather between steps. On the paused clock the sleep advances
    // virtual time, so two back-to-back run steps take at least one gap.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "true", "b", "fail"),
        run_step("b", "true", STOP, "fail"),
    ]);
    host.say("__bsdone_0__\r\n"); // step a
    host.say("__bsdone_0__\r\n"); // step b
    let start = tokio::time::Instant::now();
    assert!(engine.run_sequence(&c).await.ok);
    assert!(
        start.elapsed() >= super::STEP_GAP,
        "no gap between the two steps",
    );
}

#[tokio::test(start_paused = true)]
async fn no_gap_is_added_after_a_wait_step() {
    // A wait was already a deliberate delay; it must not also pay the breather.
    // wait 100s then a run step: the total should be the wait and nothing more.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        SeqStep::Wait {
            id: "a".into(),
            seconds: 100,
            next: "b".into(),
        },
        run_step("b", "true", STOP, "fail"),
    ]);
    host.say("__bsdone_0__\r\n");
    let start = tokio::time::Instant::now();
    assert!(engine.run_sequence(&c).await.ok);
    let elapsed = start.elapsed();
    assert!(
        elapsed >= Duration::from_secs(100),
        "the wait did not hold: {elapsed:?}",
    );
    assert!(
        elapsed < Duration::from_secs(100) + super::STEP_GAP,
        "a breather was stacked onto the wait: {elapsed:?}",
    );
}

#[tokio::test(start_paused = true)]
async fn wait_step_holds_then_advances() {
    // The redrawing-status-screen case: hold on the current screen for a fixed
    // time, sending nothing, then move on. On the paused clock the delay
    // resolves instantly and deterministically.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        SeqStep::Wait {
            id: "a".into(),
            seconds: 40,
            next: "b".into(),
        },
        run_step("b", "echo after", STOP, STOP),
    ]);
    host.say(&echo_of("echo after"));
    host.say("after\r\n__bsdone_0__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    // It sent nothing during the wait, then ran the next step.
    assert!(host.typed().contains("echo after"));
    assert!(!host.typed().contains("40"), "the wait typed something");
}

#[tokio::test(start_paused = true)]
async fn wait_step_can_be_skipped_early() {
    let (mut engine, host) = harness();
    let c = cfg(vec![SeqStep::Wait {
        id: "a".into(),
        seconds: 3600,
        next: STOP.into(),
    }]);
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = ctl.send(Ctl::SkipStep);
    });
    // Skipping a full-hour wait returns at once rather than after an hour.
    assert!(engine.run_sequence(&c).await.ok);
}

#[tokio::test(start_paused = true)]
async fn wait_step_keeps_draining_output_while_it_holds() {
    // A redrawing monitor keeps sending bytes during the wait; they must be
    // consumed, not left to pile up in the unbounded tap channel.
    let (mut engine, host) = harness();
    let c = cfg(vec![SeqStep::Wait {
        id: "a".into(),
        seconds: 30,
        next: STOP.into(),
    }]);
    for _ in 0..100 {
        host.say("\rAttempt n: redrawing status");
    }
    assert!(engine.run_sequence(&c).await.ok);
}

#[tokio::test(start_paused = true)]
async fn send_step_writes_literal_keys() {
    let (mut engine, host) = harness();
    let c = cfg(vec![SeqStep::Send {
        id: "a".into(),
        input: "q".into(), // dismiss the monitor
        next: STOP.into(),
    }]);
    assert!(engine.run_sequence(&c).await.ok);
    assert_eq!(host.typed(), "q");
}

#[tokio::test(start_paused = true)]
async fn a_transient_match_that_repaints_away_does_not_fire() {
    // The settle window's reason for existing: text flashes, then the program
    // erases it. Answering what is no longer on screen would be wrong.
    let (mut engine, host) = harness();
    let c = cfg(vec![on_timeout(
        expect_step("a", "Ready", Some("y\n"), STOP),
        TimeoutAction::Fail,
    )]);
    host.say("Ready");
    host.say("\rWorking\x1b[K"); // repainted over before the settle elapses
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok, "answered a prompt that had vanished");
    assert_eq!(host.typed(), "", "should not have sent anything");
}

// -------------------------------------------------------- timeout and pause

#[tokio::test(start_paused = true)]
async fn run_step_timeout_with_fail_takes_the_failure_branch() {
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "hangs", STOP, "b"),
        run_step("b", "echo recovered", STOP, STOP),
    ]);
    // Step b's reply has to wait until step a has actually timed out:
    // queueing it up front would let step a match b's completion marker and
    // "succeed", which is a different bug than the one under test.
    let data = host.data.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        let _ = data.send(TapMsg::Data(
            b" echo recovered; printf '__bsdone_%s__\\n' \"$?\"\r\nrecovered\r\n__bsdone_0__\r\n"
                .to_vec(),
        ));
    });
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(host.typed().contains("echo recovered"));
}

#[tokio::test(start_paused = true)]
async fn expect_step_timeout_pauses_for_the_operator_by_default() {
    // The locked decision: pause, don't silently fail.
    let (mut engine, host) = harness();
    let c = cfg(vec![expect_step("a", "never appears", None, STOP)]);
    let ctl = host.ctl.clone();
    let events = host.events.clone();
    // Let it pause, then stop the host.
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        let _ = ctl.send(Ctl::Abort);
    });
    engine.run_sequence(&c).await;
    let reasons = events.paused_reasons();
    assert_eq!(reasons.len(), 1, "expected exactly one pause");
    assert!(reasons[0].contains("never appears"), "{}", reasons[0]);
}

#[tokio::test(start_paused = true)]
async fn resume_after_a_pause_does_not_re_run_the_command() {
    // The whole reason resume re-enters the *wait* and not the *step*: the
    // command is still running out there. Re-sending `apt upgrade` because it
    // was slow would be its own disaster.
    let (mut engine, host) = harness();
    let c = cfg(vec![on_timeout(
        run_step("a", "apt -y upgrade", STOP, "fail"),
        TimeoutAction::Pause,
    )]);
    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        // Let the step time out and park.
        tokio::time::sleep(Duration::from_secs(45)).await;
        let _ = ctl.send(Ctl::Resume { clear: false });
        // The slow command finally finishes.
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = data.send(TapMsg::Data(b"done\r\n__bsdone_0__\r\n".to_vec()));
    });
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(host.writes().len(), 1, "the command was sent twice: {:?}", host.writes());
}

#[tokio::test(start_paused = true)]
async fn skip_step_after_a_pause_takes_the_success_branch() {
    let (mut engine, host) = harness();
    let c = cfg(vec![
        expect_step("a", "never appears", None, "b"),
        run_step("b", "echo moved on", STOP, STOP),
    ]);
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        let _ = ctl.send(Ctl::SkipStep);
    });
    host.say(&echo_of("echo moved on"));
    host.say("moved on\r\n__bsdone_0__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(host.typed().contains("echo moved on"));
}

#[tokio::test(start_paused = true)]
async fn abort_after_a_pause_stops_the_host() {
    let (mut engine, host) = harness();
    let c = cfg(vec![
        expect_step("a", "never appears", None, "b"),
        run_step("b", "should not run", STOP, STOP),
    ]);
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        let _ = ctl.send(Ctl::Abort);
    });
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert!(outcome.message.contains("operator"), "{}", outcome.message);
    assert!(!host.typed().contains("should not run"));
    // Abort closes the shell.
    assert_eq!(outcome.disposition, Disposition::Aborted);
}

#[tokio::test(start_paused = true)]
async fn detach_after_a_pause_hands_the_shell_off() {
    // The operator sends the paused host's shell to a terminal tab. The engine
    // stops (the next step never runs) but the disposition says hand off, not
    // close: the shell stays open for the terminal to adopt.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        expect_step("a", "never appears", None, "b"),
        run_step("b", "should not run", STOP, STOP),
    ]);
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        let _ = ctl.send(Ctl::Detach);
    });
    let outcome = engine.run_sequence(&c).await;
    assert_eq!(outcome.disposition, Disposition::Detached);
    assert!(outcome.ok, "{}", outcome.message);
    assert!(!host.typed().contains("should not run"));
}

#[tokio::test(start_paused = true)]
async fn a_failed_step_keeps_the_finished_disposition() {
    // A natural end, even an unhappy one, keeps `Finished`: a transfer-enabled
    // skill leaves that shell open for inspection. Only an operator abort closes.
    let (mut engine, _host) = harness();
    let c = cfg(vec![on_timeout(
        expect_step("a", "never appears", None, STOP),
        TimeoutAction::Fail,
    )]);
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert_eq!(outcome.disposition, Disposition::Finished);
}

#[tokio::test(start_paused = true)]
async fn probe_uid_reads_root_and_non_root() {
    let (mut engine, host) = harness();
    host.say("__bsuid_0__\r\n");
    assert_eq!(engine.probe_uid().await, Some(true));
    host.say("__bsuid_1000__\r\n");
    assert_eq!(engine.probe_uid().await, Some(false));
}

#[tokio::test(start_paused = true)]
async fn run_host_probes_uid_when_transfer_is_allowed() {
    // Transfer on: run_host probes at the opening prompt so the outcome carries
    // the root flag the handoff and close-run warnings need.
    let (engine, host) = harness();
    let mut c = cfg(vec![run_step("a", "true", STOP, "fail")]);
    c.allow_transfer = true;
    host.say("__bsshell_-bash__\r\n"); // detect_shell
    host.say("__bsuid_0__\r\n"); // opening uid probe
    host.say("__bsdone_0__\r\n"); // the step
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.is_root, Some(true));
    assert!(host.typed().contains("__bsuid_"), "should have probed uid");
}

#[tokio::test(start_paused = true)]
async fn run_host_skips_the_uid_probe_when_transfer_is_off() {
    // Transfer off: the shell always closes on finish, so root status is never
    // used. run_host skips the probe entirely, so its echoed `id -u` line never
    // reaches the operator's pane and the outcome carries no root flag.
    let (engine, host) = harness();
    let c = cfg(vec![run_step("a", "true", STOP, "fail")]); // allow_transfer: false
    host.say("__bsshell_-bash__\r\n"); // detect_shell
    host.say("__bsdone_0__\r\n"); // the step
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(outcome.is_root, None);
    assert!(!host.typed().contains("__bsuid_"), "must not probe uid");
}

#[tokio::test(start_paused = true)]
async fn an_abort_skips_the_closing_probe() {
    // Stop host must stop now. The tail work run_host does on a natural finish
    // (linger, then re-probe the uid) types into the shell, and the shell an
    // abort is most likely to be parked at is one sitting on an unanswered sudo
    // password prompt: the probe line went in as a password guess and the
    // operator then waited out its timeout before the host stopped.
    let (engine, host) = harness();
    let mut c = cfg(vec![expect_step("a", "never appears", None, STOP)]);
    c.allow_transfer = true; // the probe is only ever armed with transfer on
    host.say("__bsshell_-bash__\r\n"); // detect_shell
    host.say("__bsuid_1000__\r\n"); // the opening probe, which does still run
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(75)).await;
        let _ = ctl.send(Ctl::Abort);
    });
    let outcome = run_host(engine, &c).await;
    assert_eq!(outcome.disposition, Disposition::Aborted);
    // One probe (the opening one), not two: nothing was typed on the way out.
    assert_eq!(host.typed().matches("__bsuid_").count(), 1);
}

#[tokio::test(start_paused = true)]
async fn operator_takeover_noise_is_cleared_on_resume() {
    // The operator types at the paused pane. What they did must not satisfy the
    // pattern the engine is about to wait for again, so a typed-through pause
    // resumes with `clear: true`.
    let (mut engine, host) = harness();
    let c = cfg(vec![expect_step("a", "READY", None, STOP)]);
    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        // While parked, the operator's own session prints the magic word.
        let _ = data.send(TapMsg::Data(b"$ echo READY\r\nREADY\r\n".to_vec()));
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = ctl.send(Ctl::Resume { clear: true });
        tokio::time::sleep(Duration::from_secs(90)).await;
        let _ = ctl.send(Ctl::Abort);
    });
    let outcome = engine.run_sequence(&c).await;
    // Cleared on resume → the pattern was never satisfied → it paused again and
    // we aborted it. If takeover noise had counted, this would have "succeeded".
    assert!(!outcome.ok, "takeover output satisfied the pattern");
    assert_eq!(host.events.paused_reasons().len(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_value_arriving_during_a_pause_satisfies_an_untyped_resume() {
    // The parked-match case's second half: the awaited text lands while parked (a slow
    // host, or output the previous step provoked). The operator only watched,
    // so resume must not wipe it; the retried wait sees it immediately.
    let (mut engine, host) = harness();
    let c = cfg(vec![expect_step("a", "READY", None, STOP)]);
    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        // The host catches up on its own while parked.
        let _ = data.send(TapMsg::Data(b"READY\r\n".to_vec()));
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = ctl.send(Ctl::Resume { clear: false });
    });
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(host.events.paused_reasons().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_match_does_not_consume_a_later_value_on_the_same_line() {
    // The two-values case's first half: a repainting program keeps both values
    // on one unterminated line. Matching the first must leave the second matchable, or the
    // second step times out on text the operator can plainly see.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        expect_step("a", "web: ok", None, "b"),
        expect_step("b", "db: ok", None, STOP),
    ]);
    host.say("web: ok  db: ok");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(host.events.paused_reasons().is_empty(), "a step paused");
}

// ------------------------------------------------------ cancel and teardown

#[tokio::test(start_paused = true)]
async fn dropping_the_control_channel_aborts_the_host() {
    // How emergency-stop reaches a host that is mid-wait: SkillRunState::cancel
    // drops the run entry, closing every control sender.
    let (mut engine, host) = harness();
    let c = cfg(vec![run_step("a", "sleep 600", STOP, "fail")]);
    drop(host.ctl);
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert!(outcome.message.contains("operator"), "{}", outcome.message);
}

#[tokio::test(start_paused = true)]
async fn a_closed_shell_ends_the_host_cleanly() {
    let (mut engine, host) = harness();
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    host.close();
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert!(outcome.message.contains("closed"), "{}", outcome.message);
}

#[tokio::test(start_paused = true)]
async fn a_branch_cycle_stops_at_the_execution_cap() {
    let (mut engine, host) = harness();
    let c = cfg(vec![SeqStep::Send {
        id: "a".into(),
        input: "x".into(),
        next: "a".into(), // sends forever
    }]);
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert!(outcome.message.contains("loop"), "{}", outcome.message);
    assert_eq!(host.writes().len(), MAX_STEP_EXECUTIONS);
}

#[tokio::test(start_paused = true)]
async fn a_missing_branch_target_fails_the_host() {
    let (mut engine, _host) = harness();
    let c = SequenceConfig {
        params: vec![],
        start_step_id: "ghost".into(),
        steps: vec![run_step("a", "true", STOP, STOP)],
        allow_transfer: false,
    };
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert!(outcome.message.contains("not found"));
}

// ------------------------------------------------------------ shell support

#[tokio::test(start_paused = true)]
async fn detects_a_bash_login_shell() {
    let (mut engine, host) = harness();
    // The echo carries the literal format string; only the result has a value.
    host.say(" printf '__bsshell_%s__\\n' \"$0\"\r\n__bsshell_-bash__\r\n");
    assert_eq!(engine.detect_shell().await.unwrap(), "bash");
}

#[tokio::test(start_paused = true)]
async fn detects_zsh_by_path() {
    let (mut engine, host) = harness();
    host.say("__bsshell_/usr/bin/zsh__\r\n");
    assert_eq!(engine.detect_shell().await.unwrap(), "zsh");
}

#[tokio::test(start_paused = true)]
async fn detects_plain_sh() {
    let (mut engine, host) = harness();
    host.say("__bsshell_sh__\r\n");
    assert_eq!(engine.detect_shell().await.unwrap(), "sh");
}

#[tokio::test(start_paused = true)]
async fn refuses_an_unsupported_shell_before_any_step_runs() {
    let (mut engine, host) = harness();
    host.say("__bsshell_fish__\r\n");
    let err = engine.detect_shell().await.unwrap_err();
    assert!(err.contains("fish"), "{err}");
    // Worded as "currently", so adding fish later doesn't make a liar of it.
    assert!(err.contains("Currently only bash, zsh and sh"), "{err}");
}

#[tokio::test(start_paused = true)]
async fn a_shell_that_never_identifies_itself_is_refused() {
    let (mut engine, _host) = harness();
    let err = engine.detect_shell().await.unwrap_err();
    assert!(err.contains("Could not identify"), "{err}");
}

#[tokio::test(start_paused = true)]
async fn shell_probe_echo_alone_is_not_a_detection() {
    // If the engine matched its own echo it would read the shell as "%s".
    let (mut engine, host) = harness();
    host.say(" printf '__bsshell_%s__\\n' \"$0\"\r\n");
    assert!(engine.detect_shell().await.is_err());
}

// ------------------------------------------------------------- persistence

#[tokio::test(start_paused = true)]
async fn the_shell_is_persistent_across_steps() {
    // The feature's core promise: `sudo -i` in an early step leaves every later
    // step running as root, because it is one long-lived shell rather than a
    // command per step. The engine models that by simply never reconnecting.
    // this pins the interactive-step handoff that makes it usable.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        // sudo -i opens a nested shell: no marker to wait for.
        interactive(run_step("a", "sudo -i", "b", "fail")),
        run_step("b", "whoami", STOP, "fail"),
    ]);
    host.say("[sudo] password for joe: \r\nroot@web01:~# ");
    host.say(&echo_of("whoami"));
    host.say("root\r\n__bsdone_0__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    let typed = host.typed();
    assert!(typed.contains("sudo -i"));
    // The interactive step sent no completion marker…
    assert!(!typed.contains(r#"sudo -i; printf"#));
    // …and the next step ran in that same shell.
    assert!(typed.contains("whoami; printf"));
}

#[tokio::test(start_paused = true)]
async fn progress_events_narrate_the_run() {
    let (mut engine, host) = harness();
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    host.say("__bsdone_0__\r\n");
    engine.run_sequence(&c).await;
    let phases = host.events.phases();
    assert!(phases.contains(&"step".to_string()));
    assert!(phases.contains(&"matched".to_string()));
}

// ------------------------------------------------------------------ prepare

#[test]
fn prepare_substitutes_validates_and_rejects_a_broken_graph() {
    let c = SequenceConfig {
        params: vec![SkillParam {
            key: "repo".into(),
            label: "Repo".into(),
            required: true,
            default: None,
        }],
        start_step_id: "a".into(),
        steps: vec![run_step("a", "git clone {{repo}}", STOP, STOP)],
        allow_transfer: false,
    };
    let values: std::collections::HashMap<String, String> =
        [("repo".to_string(), "my repo".to_string())].into();
    let out = prepare(&c, &values).unwrap();
    match &out.steps[0] {
        SeqStep::Run { command, .. } => assert_eq!(command, "git clone 'my repo'"),
        _ => panic!("wrong step"),
    }
    // A required param the user left blank never reaches a host.
    assert!(prepare(&c, &std::collections::HashMap::new()).is_err());
}

#[test]
fn needs_sudo_password_spots_a_sudo_step() {
    let c = cfg(vec![run_step("a", "sudo -i", STOP, STOP)]);
    assert!(needs_sudo_password(&c));
    let c = cfg(vec![run_step("a", "uptime", STOP, STOP)]);
    assert!(!needs_sudo_password(&c));
}

#[test]
fn parse_sequence_rejects_a_malformed_config() {
    assert!(parse_sequence("{ not json").is_err());
    assert!(parse_sequence(r#"{"startStepId":"a","steps":[]}"#).is_ok());
}
