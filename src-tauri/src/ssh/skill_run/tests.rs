//! Engine tests. [`PtyLink`] is a pair of channels, so the whole expect/send
//! state machine runs against a scripted fake host: no SSH, no live shell.
//!
//! Every test runs on a paused clock (`start_paused`): timeouts and settle
//! windows resolve instantly and deterministically. Responses are queued into
//! the data channel *before* the engine starts, which is also the real
//! ordering (a host's output routinely lands while the previous step is still
//! finishing), and it means no test races the engine to feed it.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use super::config::{
    LogLevel, MatchBranch, SeqStep, SequenceConfig, SkillParam, TimeoutAction,
    DEFAULT_MAX_STEP_REPEATS, MAX_STEP_REPEATS_LIMIT, STOP,
};
use super::state::Ctl;
use super::*;

#[derive(Default)]
struct Collected {
    progress: Vec<SkillProgress>,
    paused: Vec<SkillPaused>,
    done: Vec<SkillDone>,
    steps: Vec<SkillStepDone>,
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
    fn step_finished(&self, payload: SkillStepDone) {
        self.0.lock().unwrap().steps.push(payload);
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
    /// The record of the run: one entry per step that finished.
    fn steps(&self) -> Vec<SkillStepDone> {
        self.0.lock().unwrap().steps.clone()
    }
    /// The events the panel reads as "a step is starting now", as
    /// `(step_id, countdown)`. Told by `step_kind`, exactly as the panel tells
    /// them: it is the announcement that restarts the countdown.
    fn step_announcements(&self) -> Vec<(String, Option<u64>)> {
        self.0
            .lock()
            .unwrap()
            .progress
            .iter()
            .filter(|p| p.step_kind.is_some())
            .map(|p| (p.step_id.clone().unwrap_or_default(), p.step_secs))
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
        // This host says nothing back unless a test tells it to, so nothing
        // ever lifts the curtain and the engine reaches its deadline every
        // time. That is the intended shape here: these tests are about the
        // state machine, and the pane is [`super::pane_tests`]'s subject.
        curtain: Curtain::new(),
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
        on_timeout_target: None,
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
        SeqStep::Send { .. } | SeqStep::Wait { .. } | SeqStep::Log { .. } => {}
    }
    step
}

/// Point a step's timeout at another step: "if this doesn't arrive, go there".
fn timeout_goto(mut step: SeqStep, target: &str) -> SeqStep {
    match &mut step {
        SeqStep::Run {
            on_timeout,
            on_timeout_target,
            ..
        }
        | SeqStep::Expect {
            on_timeout,
            on_timeout_target,
            ..
        } => {
            *on_timeout = TimeoutAction::Goto;
            *on_timeout_target = Some(target.into());
        }
        SeqStep::Send { .. } | SeqStep::Wait { .. } | SeqStep::Log { .. } => {}
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
        on_timeout_target: None,
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
        max_step_repeats: None,
        unlimited_step_repeats: false,
    }
}

/// The echo a real shell sends back for a sentinel-wrapped command.
fn echo_of(command: &str) -> String {
    format!(" {command}; printf '__bsdone_%s__\\n' \"$?\"\r\n")
}

// ------------------------------------------------------- a host that answers
//
// The tests above script a host by queueing what it says before the engine
// starts, which is both simpler and the real ordering for text. It cannot be
// the ordering for marks: the quiet path turns entirely on what the shell says
// *after* a command goes out, and a mark queued in advance would be read, and
// armed away, before the command that asks for it is ever typed. So this half
// of the harness answers what is typed at it instead.

/// The shell's side of a host with Broadside's OSC 133 integration on it.
struct Script {
    /// Exit code and output for the commands still to come, in order. A command
    /// with nothing scripted exits 0 and prints nothing.
    replies: VecDeque<(i32, String)>,
    /// Whether this shell has the hooks. `sudo -i` takes them away, exactly as
    /// it does on a real host: the nested shell is a different shell.
    hooked: bool,
    /// Whether being offered the hooks installs them. False for the shell that
    /// simply will not take them, which is the case the fallback exists for.
    takes_hooks: bool,
    /// Whether it says where a command's output starts as well as how the
    /// command ended. False for a shell that has somehow kept the completion
    /// hook and lost the one in front of it, which leaves the engine with
    /// completions it cannot tell apart from the previous line's.
    reports_start: bool,
}

impl Script {
    fn answer(&mut self, typed: &str) -> String {
        if !typed.contains('\n') {
            // A bare control character submits nothing and starts nothing.
            return String::new();
        }
        let line = typed.trim();
        // Everything typed at a terminal is echoed. Keeping that unconditional
        // is the point of the current design: nothing is asked of the shell to
        // stop it, so nothing about the shell can make hiding fail.
        let out = format!("{line}\r\n");
        if line.contains("sudo -i") {
            self.hooked = false;
            return out;
        }
        let printed = if line.contains("__omni_precmd") {
            if self.takes_hooks {
                self.hooked = true;
            }
            let answer = if self.hooked { "y" } else { "n" };
            format!("\x1b]{};{HOOK_MARKER}{answer}__\x07", screen::BS_OSC)
        } else if line.contains(SHELL_MARKER) {
            format!("\x1b]{};{SHELL_MARKER}-bash__\x07", screen::BS_OSC)
        } else if line.contains(UID_MARKER) {
            format!("\x1b]{};{UID_MARKER}0__\x07", screen::BS_OSC)
        } else {
            let (code, text) = self.replies.pop_front().unwrap_or((0, String::new()));
            return self.finish(out, &text, code, line);
        };
        self.finish(out, &printed, 0, line)
    }

    /// The tail of one command: what it printed, then how the shell accounts for
    /// it. A hooked one says so out of band; an unhooked one says nothing about
    /// itself at all. Either kind still runs the marker the engine appended,
    /// which is the whole of why the fallback wrapper works everywhere.
    fn finish(&self, mut out: String, printed: &str, code: i32, line: &str) -> String {
        if self.hooked && self.reports_start {
            out.push_str("\x1b]133;C\x07");
        }
        out.push_str(printed);
        if line.contains(DONE_MARKER) {
            out.push_str(&format!("{DONE_MARKER}{code}__\r\n"));
        }
        if self.hooked {
            // The completion, the next prompt, and the mark the integration
            // puts on the end of `PS1`. That last one is what lifts the
            // curtain, so a shell without the hooks has to leave it out: a fake
            // that always sent it would hide the one case the deadline exists
            // for.
            out.push_str(&format!(
                "\x1b]133;D;{code}\x07\x1b]133;A\x07$ \x1b]133;B\x07"
            ));
        }
        out
    }
}

/// An engine talking to a shell that reports its own completions, set up the
/// way the app sets one up: the connect-time probe read bash, so the OSC 133
/// integration went in with the session.
fn hooked_harness() -> (Engine<CollectEvents>, Host, Arc<Mutex<Script>>) {
    hooked_harness_with(false)
}

/// The same, with the operator's **Where to log** answer. `quiet` is "Skill Log
/// Only": the record belongs in Broadside, so the host is asked to stop keeping
/// one of its own.
fn hooked_harness_with(quiet: bool) -> (Engine<CollectEvents>, Host, Arc<Mutex<Script>>) {
    let (data_tx, data_rx) = mpsc::unbounded_channel();
    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
    let writes = Arc::new(Mutex::new(Vec::new()));
    let script = Arc::new(Mutex::new(Script {
        replies: VecDeque::new(),
        hooked: true,
        takes_hooks: true,
        reports_start: true,
    }));
    let sink = writes.clone();
    let shell = script.clone();
    let back = data_tx.clone();
    let curtain = Curtain::new();
    let tap_curtain = curtain.clone();
    let link = PtyLink {
        rx: data_rx,
        write: Box::new(move |b: &[u8]| {
            let text = String::from_utf8_lossy(b).to_string();
            sink.lock().unwrap().push(text.clone());
            let reply = shell.lock().unwrap().answer(&text);
            if !reply.is_empty() {
                // Through the curtain first and the channel second, the order
                // [`super::SkillTap`] uses, so that a prompt mark in this reply
                // has lifted the curtain by the time the engine reads it.
                let bytes = reply.into_bytes();
                let _ = tap_curtain.filter(&bytes);
                let _ = back.send(TapMsg::Data(bytes));
            }
            Ok(())
        }),
        curtain: curtain.clone(),
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
    )
    .with_known_capability(ShellCapability::Full)
    .with_integration_sent(true)
    .with_quiet_history(quiet);
    (
        engine,
        Host {
            data: data_tx,
            ctl: ctl_tx,
            writes,
            events,
        },
        script,
    )
}

impl Host {
    /// What the operator would have seen typed at their shell, with the
    /// engine's own hidden plumbing left out of it.
    fn commands(&self) -> Vec<String> {
        self.writes()
            .iter()
            .map(|w| w.trim().to_string())
            .filter(|w| {
                // A hidden line is one line now, and every one of them carries
                // the marker of the question it is asking.
                !w.is_empty()
                    && !w.contains(SHELL_MARKER)
                    && !w.contains(UID_MARKER)
                    && !w.contains(HOOK_MARKER)
            })
            .collect()
    }
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

// ------------------------------------------------------------------- log steps

/// Every progress line as `phase:detail`, which is what the run log shows.
fn details(host: &Host) -> Vec<String> {
    host.events
        .0
        .lock()
        .unwrap()
        .progress
        .iter()
        .map(|p| format!("{}:{}", p.phase, p.detail))
        .collect()
}

fn log_step(id: &str, level: LogLevel, message: &str, next: &str) -> SeqStep {
    SeqStep::Log {
        id: id.into(),
        level,
        message: message.into(),
        next: next.into(),
    }
}

#[tokio::test(start_paused = true)]
async fn a_log_step_posts_its_message_and_touches_nothing() {
    let (mut engine, host) = harness();
    let c = cfg(vec![log_step(
        "a",
        LogLevel::Info,
        "took the already-patched branch",
        STOP,
    )]);
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    // The whole point: nothing was typed at the host.
    assert_eq!(host.typed(), "");
    let details = details(&host);
    assert!(
        details
            .iter()
            .any(|d| d == "info:took the already-patched branch"),
        "{details:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_warning_log_step_carries_on_to_its_next_step() {
    let (mut engine, host) = harness();
    let c = cfg(vec![
        log_step("a", LogLevel::Warn, "swap is nearly full", "b"),
        run_step("b", "echo carried on", STOP, STOP),
    ]);
    host.say(&echo_of("echo carried on"));
    host.say("carried on\r\n__bsdone_0__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(host.typed().contains("echo carried on"));
    assert!(host.events.phases().iter().any(|p| p == "warn"));
}

#[tokio::test(start_paused = true)]
async fn an_error_log_step_that_stops_fails_the_host_in_its_own_words() {
    // The whole reason the level matters: a skill that decides this host is not
    // for it must not finish with a green tick.
    let (mut engine, _host) = harness();
    let c = cfg(vec![log_step(
        "a",
        LogLevel::Error,
        "cancelled itself: this host is not a web server",
        STOP,
    )]);
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok, "{outcome:?}");
    assert_eq!(
        outcome.message,
        "cancelled itself: this host is not a web server"
    );
}

#[tokio::test(start_paused = true)]
async fn an_error_log_step_that_goes_somewhere_is_not_the_end_of_the_host() {
    // Error is about how loud the line is, not about ending the run: a skill
    // can log an error and still go and clean up after itself.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        log_step("a", LogLevel::Error, "the upgrade failed", "b"),
        run_step("b", "echo cleaning up", STOP, STOP),
    ]);
    host.say(&echo_of("echo cleaning up"));
    host.say("cleaning up\r\n__bsdone_0__\r\n");
    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(host.typed().contains("echo cleaning up"));
}

#[tokio::test(start_paused = true)]
async fn a_failing_log_step_says_it_once_not_twice() {
    // A refusal is one line. The step announcement carries the message itself,
    // so the failure is not also posted separately, and the generic "step log:
    // no" that used to precede it (untinted, saying the same thing) is gone.
    let (mut engine, host) = harness();
    let c = cfg(vec![log_step("a", LogLevel::Error, "no", STOP)]);
    engine.run_sequence(&c).await;
    let details = details(&host);
    assert_eq!(
        details.iter().filter(|d| d.as_str() == "failed:no").count(),
        1,
        "{details:?}"
    );
    assert!(
        !details.iter().any(|d| d.starts_with("step:")),
        "the log step announced itself twice: {details:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_log_steps_line_still_says_which_step_it_is() {
    // The one line a log step posts is also its step announcement, so it has to
    // carry the step metadata the run panel reads: without it the panel would
    // sit on the previous step for the whole of a skill made of log steps.
    let (mut engine, host) = harness();
    let c = cfg(vec![log_step("a", LogLevel::Info, "hello", STOP)]);
    engine.run_sequence(&c).await;
    let announced = host
        .events
        .0
        .lock()
        .unwrap()
        .progress
        .iter()
        .any(|p| p.step_kind.as_deref() == Some("log") && p.step_id.as_deref() == Some("a"));
    assert!(announced, "the log step never announced itself");
}

#[tokio::test(start_paused = true)]
async fn an_uncapped_skill_runs_far_past_the_cap_and_still_stops_when_told() {
    // Two log steps pointing at each other: no PTY traffic at all, so nothing
    // in the loop waits on the host. With the cap removed this is the worst
    // case for termination, and the run must still (a) keep going well past the
    // cap and (b) stop the moment the operator says so.
    let (mut engine, host) = harness();
    let mut c = cfg(vec![
        log_step("a", LogLevel::Info, "round trip", "b"),
        log_step("b", LogLevel::Info, "and back", "a"),
    ]);
    c.unlimited_step_repeats = true;
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        // Simulated time: the engine paces itself at STEP_GAP per step, so this
        // lands after a few hundred of them.
        tokio::time::sleep(Duration::from_secs(10)).await;
        let _ = ctl.send(Ctl::Abort);
    });
    let outcome = engine.run_sequence(&c).await;
    assert_eq!(outcome.disposition, Disposition::Aborted, "{outcome:?}");
    // A log step announces itself under its own level, so `info` here is one
    // line per step run.
    let steps = host
        .events
        .phases()
        .iter()
        .filter(|p| p.as_str() == "info")
        .count();
    assert!(
        steps > DEFAULT_MAX_STEP_REPEATS as usize * 2,
        "an uncapped skill stopped early: {steps} steps"
    );
}

#[tokio::test(start_paused = true)]
async fn an_uncapped_skill_stops_when_its_run_is_cancelled() {
    // The emergency stop drops the control sender rather than sending anything,
    // so a disconnected channel has to read as "stop" here too.
    let (mut engine, host) = harness();
    let mut c = cfg(vec![log_step("a", LogLevel::Info, "forever", "a")]);
    c.unlimited_step_repeats = true;
    drop(host.ctl);
    let outcome = engine.run_sequence(&c).await;
    assert_eq!(outcome.disposition, Disposition::Aborted, "{outcome:?}");
}

#[test]
fn removing_the_cap_is_explicit_not_a_number_out_of_range() {
    // A bad number is a typo and stays capped; only the flag removes the limit.
    let mut c = cfg(vec![run_step("a", "true", STOP, STOP)]);
    c.max_step_repeats = Some(0);
    assert_eq!(c.step_repeat_limit(), Some(1));
    c.max_step_repeats = Some(9999);
    assert_eq!(c.step_repeat_limit(), Some(MAX_STEP_REPEATS_LIMIT));
    c.unlimited_step_repeats = true;
    assert_eq!(c.step_repeat_limit(), None);
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
async fn expect_step_timeout_with_goto_takes_the_recovery_step() {
    // The gap this closes: before, an expect that timed out could only fail the
    // host or park. Now it can hand off to a recovery step and carry on.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        timeout_goto(expect_step("a", "never appears", None, STOP), "b"),
        run_step("b", "echo recovered", STOP, STOP),
    ]);
    // Only answer once step a has actually timed out, so b's completion marker
    // can't be what satisfies a.
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
    // It jumped rather than parking: nobody was there to resume it.
    assert!(host.events.paused_reasons().is_empty());
}

#[tokio::test(start_paused = true)]
async fn run_step_timeout_with_goto_takes_the_target_not_the_failure_branch() {
    // A run step could already branch on timeout, but only through on_failure,
    // which conflates "timed out" with "exited non-zero". goto separates them.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        timeout_goto(run_step("a", "hangs", STOP, "wrong"), "b"),
        run_step("b", "echo recovered", STOP, STOP),
        run_step("wrong", "echo wrong branch", STOP, STOP),
    ]);
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
    assert!(
        !host.typed().contains("wrong branch"),
        "took on_failure instead of the timeout target"
    );
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
    // A resume that asks to clear does clear, screen and all. Whether it asks is
    // decided elsewhere (`SkillRunState::resume`, off the back of whether the
    // operator left anything unsubmitted on the command line); this is only that
    // the engine honours it.
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
async fn a_resumed_wait_announces_its_step_again() {
    // The wait genuinely restarts with a fresh budget, and the panel's countdown
    // is keyed off the announcement. Without a second one it kept counting from
    // when the step first started, so the whole of the second wait was spent
    // showing a red nought and the only proof the engine was still waiting was
    // the timeout arriving at the end of it (smoke 55-2 D3).
    let (mut engine, host) = harness();
    let c = cfg(vec![expect_step("a", "READY", None, STOP)]);
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        let _ = ctl.send(Ctl::Resume { clear: false });
        tokio::time::sleep(Duration::from_secs(90)).await;
        let _ = ctl.send(Ctl::Abort);
    });
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok, "{outcome:?}");
    let announced = host.events.step_announcements();
    assert_eq!(
        announced.len(),
        2,
        "one for the step, one for the resumed wait: {announced:?}"
    );
    assert_eq!(announced[0], announced[1], "same step, same fresh budget");
    assert!(announced[1].1.is_some(), "the countdown has to come with it");
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
    // The cap is per step, and this skill is one step sending to itself, so the
    // step runs exactly the limit and stops on the attempt that would exceed it.
    assert!(outcome.message.contains("step a"), "{}", outcome.message);
    assert_eq!(host.writes().len(), DEFAULT_MAX_STEP_REPEATS as usize);
}

#[tokio::test(start_paused = true)]
async fn the_repeat_cap_is_per_step_not_per_run() {
    // Two steps in a loop: each runs up to the limit, so a two-step cycle gets
    // twice the executions a one-step cycle does. The old total-executions cap
    // cut both at the same number, which meant a skill was punished for the
    // shape of its loop rather than for spinning.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        SeqStep::Send {
            id: "a".into(),
            input: "x".into(),
            next: "b".into(),
        },
        SeqStep::Send {
            id: "b".into(),
            input: "y".into(),
            next: "a".into(),
        },
    ]);
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert_eq!(host.writes().len(), DEFAULT_MAX_STEP_REPEATS as usize * 2);
}

#[tokio::test(start_paused = true)]
async fn a_lower_repeat_cap_is_honoured() {
    let (mut engine, host) = harness();
    let mut c = cfg(vec![SeqStep::Send {
        id: "a".into(),
        input: "x".into(),
        next: "a".into(),
    }]);
    c.max_step_repeats = Some(3);
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert_eq!(host.writes().len(), 3);
}

#[tokio::test(start_paused = true)]
async fn an_out_of_range_repeat_cap_is_clamped_not_obeyed() {
    // 0 would mean "no step may ever run", which is not a skill anyone meant to
    // save. Clamped to 1 rather than refused.
    let (mut engine, host) = harness();
    let mut c = cfg(vec![SeqStep::Send {
        id: "a".into(),
        input: "x".into(),
        next: "a".into(),
    }]);
    c.max_step_repeats = Some(0);
    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert_eq!(host.writes().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_missing_branch_target_fails_the_host() {
    let (mut engine, _host) = harness();
    let c = SequenceConfig {
        params: vec![],
        start_step_id: "ghost".into(),
        steps: vec![run_step("a", "true", STOP, STOP)],
        allow_transfer: false,
        max_step_repeats: None,
        unlimited_step_repeats: false,
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

// ------------------------------------------------- keeping out of the way

#[tokio::test(start_paused = true)]
async fn a_shell_that_reports_its_own_completions_is_typed_at_plainly() {
    // The point of the whole thing: what the operator watches go past is the
    // command their skill author wrote, and nothing else.
    let (engine, host, script) = hooked_harness();
    script
        .lock()
        .unwrap()
        .replies
        .push_back((0, "up 3 days\r\n".into()));
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(host.commands(), vec!["uptime"]);
    assert!(
        !host.typed().contains(DONE_MARKER),
        "nothing was appended: {:?}",
        host.typed()
    );
    // Verbatim, with no leading space: the space belongs on Broadside's own
    // lines, where it keeps them out of history, and putting one on the
    // author's line would only sit between the prompt and the command where
    // the operator can see it.
    assert!(host.writes().iter().any(|w| w == "uptime\n"));
}

// ---------------------------------------------------------------------------
// Where the run's record goes
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn remote_history_only_types_exactly_what_it_always_typed() {
    // The setting that says "leave my host recording, as it was". Nothing about
    // history may appear anywhere in the run: this is the default the engine is
    // built with, and it is byte-for-byte build 57-2.
    let (engine, host, script) = hooked_harness();
    script.lock().unwrap().replies.push_back((0, String::new()));
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    run_host(engine, &c).await;
    assert!(
        !host.typed().contains("history") && !host.typed().contains("fc -p"),
        "something was said about history when nothing should have been: {:?}",
        host.typed()
    );
}

#[tokio::test(start_paused = true)]
async fn skill_log_only_stops_the_shell_keeping_its_own_record() {
    // Twice over, and the second is the one that matters: the shell probe is the
    // first thing typed at the login shell, and the hook install is the first
    // thing typed at every shell after it, including the one a `sudo -i` opens.
    let (engine, host, script) = hooked_harness_with(true);
    script.lock().unwrap().replies.push_back((0, String::new()));
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    run_host(engine, &c).await;

    let quieted: Vec<String> = host
        .writes()
        .iter()
        .filter(|w| w.contains("set +o history"))
        .cloned()
        .collect();
    assert_eq!(
        quieted.len(),
        2,
        "expected the shell probe and the hook install to carry it, got:\n{}",
        host.writes().join("")
    );
    // zsh has no `history` option, so it gets the answer in its own terms, and
    // each branch is entered only by the shell it was written for. Swallowing
    // the other's complaint instead is not equivalent: `set +o history` in zsh
    // abandons the rest of the line, taking the shell probe with it, and every
    // zsh run then died before its first step.
    for line in &quieted {
        assert!(line.contains("fc -p"), "zsh has nothing to work with: {line}");
        assert!(
            line.contains("if [ -n \"$BASH_VERSION\" ]")
                && line.contains("elif [ -n \"$ZSH_VERSION\" ]"),
            "neither builtin may be reached by the shell it would break: {line}"
        );
    }
    // And the operator's own command is still exactly their own command.
    assert!(host.writes().iter().any(|w| w == "uptime\n"));
}

#[tokio::test(start_paused = true)]
async fn a_run_step_is_written_down_with_what_was_typed_and_what_came_back() {
    let (engine, host, script) = hooked_harness();
    script
        .lock()
        .unwrap()
        .replies
        .push_back((0, "up 3 days\r\n".into()));
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    run_host(engine, &c).await;

    let steps = host.events.steps();
    assert_eq!(steps.len(), 1, "{steps:?}");
    let step = &steps[0];
    assert_eq!(step.step_id, "a");
    assert_eq!(step.kind, "run");
    assert_eq!(step.command.as_deref(), Some("uptime"));
    assert_eq!(step.exit_code, Some(0));
    assert_eq!(step.condition, "pass");
    assert!(step.output.as_deref().unwrap().contains("up 3 days"));
    // Nothing was composed, so there is nothing to say about what was sent. An
    // entry that carries `sent` is one where it differs from the command, which
    // is what makes the Debug level worth reading.
    assert_eq!(step.sent, None, "{step:?}");
}

#[tokio::test(start_paused = true)]
async fn the_record_keeps_the_wrapper_a_shell_without_hooks_needed() {
    let (engine, host) = harness();
    let c = cfg(vec![run_step("a", "uptime", STOP, "fail")]);
    let driver = tokio::spawn(async move {
        host.say("-bash\r\n");
        host.say(&format!("\x1b]{};{SHELL_MARKER}-bash__\x07", screen::BS_OSC));
        host.say(&echo_of("uptime"));
        host.say("up 3 days\r\n");
        host.say(&format!("{DONE_MARKER}0__\r\n"));
        host
    });
    run_host(engine, &c).await;
    let host = driver.await.unwrap();

    let steps = host.events.steps();
    assert_eq!(steps.len(), 1, "{steps:?}");
    let sent = steps[0].sent.as_deref().expect("the composed line");
    assert!(sent.starts_with(" uptime; printf "), "{sent:?}");
    assert_eq!(steps[0].command.as_deref(), Some("uptime"));
}

#[tokio::test(start_paused = true)]
async fn a_step_that_failed_is_recorded_as_failed_even_where_the_run_carried_on() {
    // The branch was handled, so the run finished happily. The step still failed,
    // and a record that counted it as a pass because the skill had an `onFailure`
    // for it would be counting the wrong thing.
    let (engine, host, script) = hooked_harness();
    script.lock().unwrap().replies.push_back((3, String::new()));
    let c = cfg(vec![
        run_step("a", "test -f /etc/nginx/nginx.conf", STOP, "missing"),
        SeqStep::Log {
            id: "missing".into(),
            level: LogLevel::Info,
            message: "not installed".into(),
            next: STOP.into(),
        },
    ]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");

    let steps = host.events.steps();
    assert_eq!(steps.len(), 2, "{steps:?}");
    assert_eq!(steps[0].condition, "fail");
    assert_eq!(steps[0].exit_code, Some(3));
    assert_eq!(steps[0].next.as_deref(), Some("missing"));
    // A log step has no command and no exit code, and says so rather than
    // inventing one.
    assert_eq!(steps[1].kind, "log");
    assert_eq!(steps[1].command, None);
    assert_eq!(steps[1].exit_code, None);
    assert_eq!(steps[1].condition, "done");
}

#[tokio::test(start_paused = true)]
async fn a_host_the_operator_stopped_writes_no_step_for_the_one_it_stopped_in() {
    // Stop host during a step is the run ending, not the step failing. Writing
    // "expect: failed" for it would put a fiction in the record.
    let (engine, host) = harness();
    let c = cfg(vec![expect_step("a", "never", None, STOP)]);
    let driver = tokio::spawn(async move {
        host.say("-bash\r\n");
        host.say(&format!("\x1b]{};{SHELL_MARKER}-bash__\x07", screen::BS_OSC));
        host.ctl.send(Ctl::Abort).unwrap();
        host
    });
    run_host(engine, &c).await;
    let host = driver.await.unwrap();
    assert!(host.events.steps().is_empty(), "{:?}", host.events.steps());
}

#[tokio::test(start_paused = true)]
async fn the_exit_code_the_shell_reports_picks_the_branch() {
    let (engine, host, script) = hooked_harness();
    script.lock().unwrap().replies.push_back((3, String::new()));
    let c = cfg(vec![
        run_step("a", "test -f /etc/nginx/nginx.conf", "yes", "no"),
        SeqStep::Log {
            id: "no".into(),
            level: LogLevel::Info,
            message: "not installed".into(),
            next: STOP.into(),
        },
        SeqStep::Log {
            id: "yes".into(),
            level: LogLevel::Info,
            message: "installed".into(),
            next: STOP.into(),
        },
    ]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    let logged = host.events.0.lock().unwrap();
    assert!(
        logged.progress.iter().any(|p| p.detail == "not installed"),
        "exit 3 should take the failure branch"
    );
}

#[tokio::test(start_paused = true)]
async fn an_output_match_reads_the_output_and_not_the_command() {
    // Without the shell's own "output starts here", `consumed` would open with
    // the echo of the command line, and a step grepping for `error` would match
    // the word in its own `grep error` and take the match branch every time.
    let (engine, host, script) = hooked_harness();
    script.lock().unwrap().replies.push_back((1, String::new()));
    let mut step = run_step("a", "grep error /var/log/app.log", "found", "clean");
    if let SeqStep::Run { r#match, .. } = &mut step {
        *r#match = Some(MatchBranch {
            pattern: "error".into(),
            if_match: "found".into(),
            if_no_match: "clean".into(),
        });
    }
    let c = cfg(vec![
        step,
        SeqStep::Log {
            id: "found".into(),
            level: LogLevel::Info,
            message: "matched".into(),
            next: STOP.into(),
        },
        SeqStep::Log {
            id: "clean".into(),
            level: LogLevel::Info,
            message: "no match".into(),
            next: STOP.into(),
        },
    ]);
    run_host(engine, &c).await;
    let logged = host.events.0.lock().unwrap();
    assert!(
        logged.progress.iter().any(|p| p.detail == "no match"),
        "the echo is not output: {:?}",
        logged.progress.iter().map(|p| &p.detail).collect::<Vec<_>>()
    );
}

#[tokio::test(start_paused = true)]
async fn a_nested_shell_is_given_the_hooks_back() {
    // `sudo -i` is the first step of most skills, and the shell it opens has
    // none of the hooks the one on connect was given. Offer them again, hidden,
    // rather than spending the rest of the run typing the visible marker.
    let (engine, host, script) = hooked_harness();
    script.lock().unwrap().replies.push_back((0, String::new()));
    let c = cfg(vec![
        interactive(run_step("a", "sudo -i", "b", "fail")),
        run_step("b", "whoami", STOP, "fail"),
    ]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(
        host.typed().contains("__omni_precmd"),
        "the new shell should have been offered the hooks"
    );
    // And having taken them, the command itself still went out plain.
    assert!(
        !host.typed().contains(DONE_MARKER),
        "{:?}",
        host.typed()
    );
    assert_eq!(host.commands(), vec!["sudo -i", "whoami"]);
}

#[tokio::test(start_paused = true)]
async fn a_shell_that_will_not_take_the_hooks_falls_back_to_the_visible_marker() {
    // Asked twice, refused twice, and then left alone: a host that cannot
    // report its own completions still runs the skill, exactly as every host
    // did before it could.
    let (engine, host, script) = hooked_harness();
    {
        let mut s = script.lock().unwrap();
        s.hooked = false;
        s.takes_hooks = false;
        s.replies.push_back((0, String::new()));
        s.replies.push_back((0, String::new()));
    }
    let c = cfg(vec![
        run_step("a", "echo one", "b", "fail"),
        run_step("b", "echo two", STOP, "fail"),
    ]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(
        host.typed().contains("__bsdone_"),
        "should have fallen back: {:?}",
        host.typed()
    );
    assert_eq!(
        host.typed().matches(HOOK_MARKER).count(),
        MAX_HOOK_INSTALLS as usize,
        "and stopped asking"
    );
}

#[tokio::test(start_paused = true)]
async fn a_shell_that_keeps_taking_the_hooks_is_never_given_up_on() {
    // The cap counts refusals, not offers. A skill that opens a nested shell
    // between every pair of steps is doing something legitimate, and each one
    // that takes them costs nothing; counting those against the cap would have
    // put a long run back on the visible marker for no reason.
    let (engine, host, script) = hooked_harness();
    {
        let mut s = script.lock().unwrap();
        for _ in 0..3 {
            s.replies.push_back((0, String::new()));
        }
    }
    let c = cfg(vec![
        interactive(run_step("a", "sudo -i", "b", "fail")),
        run_step("b", "whoami", "c", "fail"),
        interactive(run_step("c", "bash", "d", "fail")),
        run_step("d", "whoami", "e", "fail"),
        interactive(run_step("e", "bash", "f", "fail")),
        run_step("f", "whoami", STOP, "fail"),
    ]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(host.typed().matches(HOOK_MARKER).count(), 3);
    assert!(
        !host.typed().contains(DONE_MARKER),
        "every one of them stayed on the quiet path: {:?}",
        host.typed()
    );
}

#[tokio::test(start_paused = true)]
async fn the_hooks_are_offered_again_after_the_operator_has_had_the_keyboard() {
    // They may have run `sudo -i` themselves. Nothing the shell said before they
    // were handed the keyboard is proof about the shell they hand back, so the
    // step after a takeover asks again where the step after an ordinary one
    // would not have needed to.
    let (engine, host, script) = hooked_harness();
    {
        let mut s = script.lock().unwrap();
        s.replies.push_back((0, String::new()));
        s.replies.push_back((0, String::new()));
    }
    let c = cfg(vec![
        run_step("a", "whoami", "w", "fail"),
        SeqStep::Wait {
            id: "w".into(),
            seconds: 60,
            next: "b".into(),
        },
        run_step("b", "whoami", STOP, "fail"),
    ]);
    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        // Land the request inside the wait, well clear of the opening probes, so
        // it is honoured in the gap before the second run step rather than
        // before the first.
        tokio::time::sleep(Duration::from_secs(30)).await;
        let _ = ctl.send(Ctl::TakeOver);
        tokio::time::sleep(Duration::from_secs(90)).await;
        let _ = ctl.send(Ctl::Resume { clear: false });
    });
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(
        host.typed().matches(HOOK_MARKER).count(),
        2,
        "once at the start of the run, once after the keyboard came back: {:?}",
        host.typed()
    );
}

#[tokio::test(start_paused = true)]
async fn a_completion_from_before_the_command_cannot_answer_it() {
    // A mark is a fact, not a position, so one left lying about would answer
    // the next command the instant it went out. This is the operator running
    // something of their own during a takeover, and the completion of *that*
    // being read as the completion of the step that follows.
    let (engine, host, script) = hooked_harness();
    script.lock().unwrap().replies.push_back((0, String::new()));
    host.say("\x1b]133;D;7\x07\x1b]133;A\x07");
    let c = cfg(vec![run_step("a", "true", STOP, "fail")]);
    let outcome = run_host(engine, &c).await;
    assert!(
        outcome.ok,
        "the stale exit 7 was taken for the step's own: {outcome:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn the_probes_answer_without_anything_being_printed() {
    // The shell and uid probes answer inside an escape no terminal draws, and
    // the line that asks is kept off the glass by the curtain rather than by
    // anything typed at the host. So a run opens with a clean pane and the
    // engine has asked the shell for nothing at all.
    let (engine, host, _script) = hooked_harness();
    let mut c = cfg(vec![run_step("a", "true", STOP, "fail")]);
    c.allow_transfer = true;
    let outcome = run_host(engine, &c).await;
    assert_eq!(outcome.is_root, Some(true), "{outcome:?}");
    let typed = host.typed();
    // Nothing is asked of the terminal, and nothing is taken back from it.
    // Every one of these was load-bearing in the old design, and every one of
    // them was a bug: the row count, the wrap, the fork-and-exec race.
    assert!(!typed.contains("stty"), "{typed:?}");
    assert!(!typed.contains("[3A"), "no cursor-up survives: {typed:?}");
    assert!(!typed.contains("[0J"), "no erase-display survives: {typed:?}");
    // A probe is one line, with a leading space to keep it out of history.
    for line in typed.lines().filter(|l| l.contains(SHELL_MARKER)) {
        assert!(line.starts_with(' '), "{line:?}");
        assert!(line.trim_end().ends_with("\"$0\""), "{line:?}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_shell_that_will_not_take_the_hooks_is_still_offered_them() {
    // The old design refused to type the hook offer at a shell that would not
    // go quiet, because the offer is most of a screenful and it would all have
    // been seen. The curtain does not care whether the shell cooperates, so the
    // offer always goes out and the only question left is what the shell says
    // back. One that says no gets the visible wrapper, as it always did.
    let (engine, host, script) = hooked_harness();
    {
        let mut s = script.lock().unwrap();
        s.takes_hooks = false;
        s.replies.push_back((0, String::new()));
    }
    let c = cfg(vec![
        interactive(run_step("a", "sudo -i", "b", "fail")),
        run_step("b", "whoami", STOP, "fail"),
    ]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(
        host.typed().contains("__omni_precmd"),
        "the offer goes out either way: {:?}",
        host.typed()
    );
    // And the step ran anyway, the way every host used to.
    assert!(host.typed().contains(DONE_MARKER));
}

#[tokio::test(start_paused = true)]
async fn a_shell_that_reports_a_completion_out_of_order_stops_being_trusted() {
    // The engine reads a completion as this command's only when the shell said
    // this command had started. A shell that reports the one and not the other
    // would otherwise time out every single step for the rest of the run, so the
    // first step to notice takes the whole run back to the visible marker.
    let (engine, host, script) = hooked_harness();
    {
        let mut s = script.lock().unwrap();
        s.reports_start = false;
        s.replies.push_back((0, String::new()));
        s.replies.push_back((0, String::new()));
    }
    let c = cfg(vec![
        run_step("a", "echo one", "b", "b"),
        run_step("b", "echo two", STOP, "fail"),
    ]);
    let outcome = run_host(engine, &c).await;
    assert!(outcome.ok, "{outcome:?}");
    assert!(
        host.events.phases().contains(&"timeout".to_string()),
        "the first step is the one that pays for finding out"
    );
    assert!(
        host.typed().contains(DONE_MARKER),
        "and the rest of the run is wrapped: {:?}",
        host.typed()
    );
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
        max_step_repeats: None,
        unlimited_step_repeats: false,
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

#[tokio::test(start_paused = true)]
async fn take_over_waits_for_the_step_to_finish() {
    // The whole point of the deferral: a request that arrives while a command
    // is running must not park the engine in the middle of it. The engine
    // finishes step a, and only then parks before step b.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "echo one", "b", STOP),
        run_step("b", "echo two", STOP, STOP),
    ]);

    let events = host.events.clone();
    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        // Step a is in flight, waiting for its completion marker.
        tokio::time::sleep(Duration::from_secs(1)).await;
        ctl.send(Ctl::TakeOver).unwrap();
        // Still mid-step a beat later: nothing has parked.
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            events.0.lock().unwrap().paused.is_empty(),
            "parked in the middle of a running step"
        );
        // Now let step a finish.
        let _ = data.send(TapMsg::Data(echo_of("echo one").into_bytes()));
        let _ = data.send(TapMsg::Data(b"one
__bsdone_0__
".to_vec()));
        // It should park before step b rather than run it.
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(
            events.0.lock().unwrap().paused.len(),
            1,
            "should be parked before the second step"
        );
        let _ = ctl.send(Ctl::Resume { clear: false });
        let _ = data.send(TapMsg::Data(echo_of("echo two").into_bytes()));
        let _ = data.send(TapMsg::Data(b"two
__bsdone_0__
".to_vec()));
    });

    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
    // Both steps ran: the first before the pause, the second after the resume.
    assert!(host.typed().contains("echo one"));
    assert!(host.typed().contains("echo two"));

    let paused = &host.events.0.lock().unwrap().paused;
    assert_eq!(paused.len(), 1);
    // Parked before the step that has not run, which is what tells the panel
    // there is nothing here for Skip step to skip.
    assert_eq!(paused[0].step_id, "b");
    assert_eq!(paused[0].kind, PauseKind::TakeOver);
}

#[tokio::test(start_paused = true)]
async fn take_over_is_spent_once_and_does_not_park_again() {
    // One request, one pause. A flag that was not cleared would park before
    // every remaining step, which is the obvious way to get this wrong.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "echo one", "b", STOP),
        run_step("b", "echo two", STOP, STOP),
    ]);
    host.ctl.send(Ctl::TakeOver).unwrap();
    host.say(&echo_of("echo one"));
    host.say("one\r\n__bsdone_0__\r\n");

    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = ctl.send(Ctl::Resume { clear: false });
        let _ = data.send(TapMsg::Data(echo_of("echo two").into_bytes()));
        let _ = data.send(TapMsg::Data(b"two\r\n__bsdone_0__\r\n".to_vec()));
    });

    assert!(engine.run_sequence(&c).await.ok);
    assert_eq!(host.events.0.lock().unwrap().paused.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_redraw_after_the_handback_cannot_satisfy_the_next_step() {
    // Smoke 55 B3, and the reason clearing the buffer once is not enough.
    //
    // The operator takes the host over before an expect step, types the very
    // text that step is waiting for, and resumes. Emptying the buffer takes
    // their echo out of it, but it does not take the half-typed line off the
    // host: the shell still has it, and reprints it the moment anything asks
    // for a redraw. Handing back is one of those things, because the pane
    // changes height and the new size goes to the host as a resize.
    //
    // So the redraw here lands a beat *after* the resume, which is exactly the
    // shape that used to slip through, and the step must still not match it.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "echo one", "b", STOP),
        on_timeout(expect_step("b", "lnop", None, STOP), TimeoutAction::Fail),
    ]);

    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        // Asked for while step a is in flight, so the engine parks in the gap
        // before step b, which is the step this is about.
        tokio::time::sleep(Duration::from_secs(1)).await;
        ctl.send(Ctl::TakeOver).unwrap();
        let _ = data.send(TapMsg::Data(echo_of("echo one").into_bytes()));
        let _ = data.send(TapMsg::Data(b"one\r\n__bsdone_0__\r\n".to_vec()));
        tokio::time::sleep(Duration::from_secs(2)).await;
        // Parked. The operator types, and the host echoes it back.
        let _ = data.send(TapMsg::Data(b"lnop".to_vec()));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = ctl.send(Ctl::Resume { clear: true });
        // The resize the hand-back caused reaches the host, and the shell
        // repaints its prompt with what is still sitting on it.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let _ = data.send(TapMsg::Data(b"\r$ lnop".to_vec()));
    });

    let outcome = engine.run_sequence(&c).await;
    // The step timed out on a pattern only the operator ever produced, which is
    // the honest answer. Matching it would report a check as passed that the
    // host never answered.
    assert!(!outcome.ok, "the redraw satisfied the step: {outcome:?}");
    assert_eq!(host.events.0.lock().unwrap().paused.len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_handback_takes_the_operators_half_typed_line_off_the_shell() {
    // Smoke 55-3 B1, and why swallowing the redraw was treating a symptom.
    //
    // The operator's `lmnop` is still on the host's command line when the run
    // carries on, so the next thing the engine types lands on the end of it:
    // `lmnop printf '__bsuid_%s__\n' "$(id -u)"` went out as one line and the
    // shell ran it. Kill the line first and the next command starts its own.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "echo one", "b", STOP),
        run_step("b", "echo two", STOP, STOP),
    ]);

    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        ctl.send(Ctl::TakeOver).unwrap();
        let _ = data.send(TapMsg::Data(echo_of("echo one").into_bytes()));
        let _ = data.send(TapMsg::Data(b"one\r\n__bsdone_0__\r\n".to_vec()));
        tokio::time::sleep(Duration::from_secs(2)).await;
        // Parked. The operator types without pressing Enter.
        let _ = data.send(TapMsg::Data(b"lmnop".to_vec()));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = ctl.send(Ctl::Resume { clear: true });
        tokio::time::sleep(Duration::from_secs(1)).await;
        let _ = data.send(TapMsg::Data(echo_of("echo two").into_bytes()));
        let _ = data.send(TapMsg::Data(b"two\r\n__bsdone_0__\r\n".to_vec()));
    });

    assert!(engine.run_sequence(&c).await.ok);
    let typed = host.typed();
    let kill = typed.find('\u{15}').expect("the line was never killed");
    let next = typed.find("echo two").expect("step b never ran");
    assert!(kill < next, "the kill has to precede the next command: {typed:?}");
    // And only the one, from the one resume that asked for it.
    assert_eq!(typed.matches('\u{15}').count(), 1, "{typed:?}");
}

#[tokio::test(start_paused = true)]
async fn a_handback_with_nothing_typed_leaves_the_line_alone() {
    // The counterpart. Nothing was left unsubmitted, so there is nothing to
    // take back, and killing a line the operator did not dirty would be the
    // engine reaching into a shell it has no reason to touch.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "echo one", "b", STOP),
        run_step("b", "echo two", STOP, STOP),
    ]);
    host.ctl.send(Ctl::TakeOver).unwrap();
    host.say(&echo_of("echo one"));
    host.say("one\r\n__bsdone_0__\r\n");

    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = ctl.send(Ctl::Resume { clear: false });
        let _ = data.send(TapMsg::Data(echo_of("echo two").into_bytes()));
        let _ = data.send(TapMsg::Data(b"two\r\n__bsdone_0__\r\n".to_vec()));
    });

    assert!(engine.run_sequence(&c).await.ok);
    assert!(!host.typed().contains('\u{15}'), "{:?}", host.typed());
}

#[tokio::test(start_paused = true)]
async fn a_handback_with_nothing_typed_still_sees_what_the_host_said() {
    // The other half, and what keeps the settle from being a blunt instrument:
    // the operator only watched, so there is nothing of theirs to forget and
    // the buffer must survive the resume intact. A value that landed while
    // parked satisfies the step it was parked before, immediately.
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "echo one", "b", STOP),
        on_timeout(expect_step("b", "READY", None, STOP), TimeoutAction::Fail),
    ]);

    let ctl = host.ctl.clone();
    let data = host.data.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        ctl.send(Ctl::TakeOver).unwrap();
        let _ = data.send(TapMsg::Data(echo_of("echo one").into_bytes()));
        let _ = data.send(TapMsg::Data(b"one\r\n__bsdone_0__\r\n".to_vec()));
        tokio::time::sleep(Duration::from_secs(2)).await;
        // The host catches up on its own while parked. Nobody typed.
        let _ = data.send(TapMsg::Data(b"READY\r\n".to_vec()));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = ctl.send(Ctl::Resume { clear: false });
    });

    let outcome = engine.run_sequence(&c).await;
    assert!(outcome.ok, "{outcome:?}");
}

#[tokio::test(start_paused = true)]
async fn a_taken_over_host_can_be_stopped_from_the_pause() {
    let (mut engine, host) = harness();
    let c = cfg(vec![
        run_step("a", "echo one", "b", STOP),
        run_step("b", "echo two", STOP, STOP),
    ]);
    host.ctl.send(Ctl::TakeOver).unwrap();
    host.say(&echo_of("echo one"));
    host.say("one\r\n__bsdone_0__\r\n");

    let ctl = host.ctl.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _ = ctl.send(Ctl::Abort);
    });

    let outcome = engine.run_sequence(&c).await;
    assert!(!outcome.ok);
    assert_eq!(outcome.disposition, Disposition::Aborted);
    // The second step never ran.
    assert!(!host.typed().contains("echo two"));
}
