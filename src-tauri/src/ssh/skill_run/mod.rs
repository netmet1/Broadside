//! The expect/send engine that drives one skill against one host's live PTY.
//!
//! A skill run opens a real, persistent shell per host through
//! [`pty`](crate::ssh::pty), the same machinery as a terminal tab, and types
//! into it. That's the whole point: a persistent shell means `sudo -i` in an
//! early step keeps every later step as root, an interactive `(y/n)` question
//! can actually be answered, and the operator watches the real terminal while
//! it happens. Output the engine matches against is the ANSI-stripped
//! [`Screen`] view; the raw bytes still stream to the live pane untouched.
//!
//! ## Sudo
//!
//! Commands are **not** rewritten through [`guard::rewrite_for_sudo`]. That
//! rewrite (`sudo -S -p ''`) exists for the one-shot exec path, where the
//! password is piped to stdin and the prompt must be suppressed. Applying it
//! here would be a hang: with `-p ''` sudo prints no prompt, so the
//! [`SudoInjector`](crate::ssh::sudo_inject) already wired into every PTY
//! session would have nothing to answer, and `-S` would consume the engine's
//! next keystrokes as the password. On a PTY, a bare `sudo` is correct: the
//! injector answers the prompt exactly as it does when the operator types it
//! by hand (D-065). `rewrite_for_sudo` is still used, but only as a *detector*,
//! to warn before the run when a host has no sudo password stored.
//!
//! ## Attended by design
//!
//! Expect automation is brittle: prompts drift, programs repaint, hosts are
//! slow. A step whose pattern never arrives **pauses for the operator** by
//! default rather than failing silently halfway through an upgrade.

pub mod config;
pub mod screen;
pub mod state;

use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::error::{AppError, AppResult};
use config::{SeqStep, SequenceConfig, TimeoutAction, MAX_STEP_EXECUTIONS, STOP};
use screen::Screen;
use state::Ctl;

pub const PROGRESS_EVENT: &str = "skill:progress";
pub const PAUSED_EVENT: &str = "skill:paused";
pub const DONE_EVENT: &str = "skill:done";

/// Completion marker for a non-interactive `run` step.
///
/// The `%s` is load-bearing. The shell echoes the command line back over the
/// PTY, so the marker text appears twice: once in the echo (as the literal
/// format string, `__bsdone_%s__`) and once in the output (with the real code,
/// `__bsdone_0__`). Matching on `(\d+)` means the echo can never be mistaken
/// for the result, because `%s` has no digits.
const DONE_MARKER: &str = "__bsdone_";
/// Same trick for shell detection: the capture class excludes `%`, so the
/// echoed `__bsshell_%s__` cannot match while `__bsshell_-bash__` does.
const SHELL_MARKER: &str = "__bsshell_";
/// Same marker trick again for the root probe: `__bsuid_0__` means the shell's
/// effective uid is 0, and `(\d+)` never matches the `%s` echo.
const UID_MARKER: &str = "__bsuid_";
/// Bound on the `id -u` root probe. It answers instantly at a live prompt; this
/// is only a floor against a wedged shell so a probe can never hang the run.
const UID_PROBE_SECS: u64 = 5;

/// How long output must be quiet before a match is acted on. Redraw-heavy
/// screens (a repainting monitor, a progress table) can flash text that is
/// gone a frame later; a short settle means we answer the screen the operator
/// would actually see. Timed from the *first* sighting, not reset by later
/// output, since a continuously repainting program would otherwise never settle.
const SETTLE: Duration = Duration::from_millis(400);
/// How long an interactive `run` step waits for output to go quiet before
/// advancing (it has no completion marker to wait for).
const INTERACTIVE_QUIET: Duration = Duration::from_millis(1200);
/// A fixed breather inserted between one step finishing and the next starting,
/// so the finished step's last bytes have landed and the shell is back at a
/// prompt before the next command is typed. Deliberately not configurable: it
/// is part of the engine's default pacing, not a knob. Not applied after a
/// `wait` step (already a delay) or when a run reaches `stop`.
const STEP_GAP: Duration = Duration::from_millis(30);
/// Bound on shell detection. A shell that hasn't identified itself by now
/// isn't going to.
const SHELL_DETECT_SECS: u64 = 15;

/// Shells whose `$?` and `printf` behave identically, which is all the engine's
/// completion marker relies on. Worded as "currently" everywhere it surfaces:
/// others (fish, etc.) can follow.
pub const SUPPORTED_SHELLS: [&str; 3] = ["bash", "zsh", "sh"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProgress {
    pub run_id: String,
    pub host_id: i64,
    pub label: String,
    pub session_id: String,
    pub step_id: Option<String>,
    /// `started` | `step` | `matched` | `sent` | `timeout` | `info` | `failed`
    pub phase: String,
    /// The kind of the step now running (`run`/`expect`/`send`/`wait`), set on
    /// the `step` phase so the run panel can offer step-specific controls.
    pub step_kind: Option<String>,
    /// The step's countdown budget in seconds, set on the `step` phase: a
    /// run/expect timeout, or a wait's duration. The panel counts down from it.
    pub step_secs: Option<u64>,
    pub detail: String,
    /// The host's effective uid == 0, once probed (after shell detection).
    /// `None` until known. Rides on every event so the panel can warn before a
    /// root shell is handed off or left open.
    pub is_root: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPaused {
    pub run_id: String,
    pub host_id: i64,
    pub label: String,
    pub session_id: String,
    pub step_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDone {
    pub run_id: String,
    pub host_id: i64,
    pub label: String,
    pub session_id: String,
    pub ok: bool,
    pub message: String,
    /// The shell's effective uid == 0 at the end of the run, if it was probed.
    /// Lets the panel flag a lingering root shell after the run finishes.
    pub is_root: Option<bool>,
}

/// Where run events go. The app implements this with Tauri events; tests
/// implement it with a channel.
pub trait SkillEvents: Send + Sync + 'static {
    fn progress(&self, payload: SkillProgress);
    fn paused(&self, payload: SkillPaused);
    fn done(&self, payload: SkillDone);
}

impl SkillEvents for tauri::AppHandle {
    fn progress(&self, payload: SkillProgress) {
        let _ = self.emit(PROGRESS_EVENT, &payload);
    }
    fn paused(&self, payload: SkillPaused) {
        let _ = self.emit(PAUSED_EVENT, &payload);
    }
    fn done(&self, payload: SkillDone) {
        // A host that ended badly is a logged failure (D-055), same as a
        // broadcast result. Never blocks the run.
        if !payload.ok {
            self.state::<crate::errlog::ErrLogState>().log(
                "skill",
                Some(payload.host_id),
                Some(&payload.label),
                &payload.message,
            );
        }
        let _ = self.emit(DONE_EVENT, &payload);
    }
}

/// One chunk of PTY traffic, or the session ending.
#[derive(Debug)]
pub enum TapMsg {
    Data(Vec<u8>),
    Closed,
}

/// Writes bytes to a host's PTY. Boxed rather than a concrete `PtyState` call
/// so tests can substitute a recorder.
type PtyWrite = Box<dyn Fn(&[u8]) -> AppResult<()> + Send>;

/// The engine's handle on one PTY: bytes in, bytes out. Abstracted so the
/// state machine can be driven by a fake in tests: the expect/send logic is
/// the riskiest part of the feature and shouldn't need a live host to exercise.
pub struct PtyLink {
    pub rx: mpsc::UnboundedReceiver<TapMsg>,
    pub write: PtyWrite,
}

/// Which host this engine is driving, for event payloads.
#[derive(Debug, Clone)]
pub struct HostMeta {
    pub run_id: String,
    pub host_id: i64,
    pub label: String,
    pub session_id: String,
}

enum Wait {
    Matched { consumed: String, group1: Option<String> },
    Timeout,
    Closed,
    Aborted,
    Detached,
    Skipped,
}

enum Park {
    Resume { clear: bool },
    Skip,
    Abort,
    Detach,
    Closed,
}

enum StepOutcome {
    Goto(String),
    Failed(String),
    Aborted,
    Detached,
    Closed,
}

/// How a host's run ended, which decides what happens to its shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Reached a natural end (finished, failed, or hit a safety limit). The
    /// shell is kept open for transfer only if the skill allows it; otherwise
    /// it is closed.
    Finished,
    /// The operator stopped this host (`Ctl::Abort` / a dropped control
    /// channel / a panic). The shell is always closed.
    Aborted,
    /// The operator handed the shell to a terminal tab (`Ctl::Detach`). The
    /// shell is kept open and handed off; it does not linger or close.
    Detached,
}

/// The result of driving one host to completion.
#[derive(Debug, Clone, PartialEq)]
pub struct HostOutcome {
    pub ok: bool,
    pub message: String,
    pub disposition: Disposition,
    /// The shell's effective uid == 0, if probed. Filled by `run_host`.
    pub is_root: Option<bool>,
}

impl HostOutcome {
    /// A natural end (finished/failed/limit): keep-open eligibility is the
    /// skill's `allow_transfer` choice, decided by the caller.
    fn finished(ok: bool, message: impl Into<String>) -> Self {
        Self {
            ok,
            message: message.into(),
            disposition: Disposition::Finished,
            is_root: None,
        }
    }
}

pub struct Engine<E: SkillEvents> {
    link: PtyLink,
    ctl: mpsc::UnboundedReceiver<Ctl>,
    screen: Screen,
    events: std::sync::Arc<E>,
    meta: HostMeta,
    /// The host's effective uid == 0, once probed. Rides on every emitted event.
    is_root: Option<bool>,
    /// The login shell the SSH-level probe read on connect (X4), used only to
    /// name the shell in the refusal message. The in-shell `$0` probe below is
    /// still the authority on whether a run may proceed, but it cannot answer
    /// on fish (`$0` is a parse error there), which is how a fish host used to
    /// be refused as "unknown".
    known_shell: Option<String>,
}

impl<E: SkillEvents> Engine<E> {
    pub fn new(
        link: PtyLink,
        ctl: mpsc::UnboundedReceiver<Ctl>,
        events: std::sync::Arc<E>,
        meta: HostMeta,
    ) -> Self {
        Self {
            link,
            ctl,
            screen: Screen::new(),
            events,
            meta,
            is_root: None,
            known_shell: None,
        }
    }

    /// Tells the engine what the SSH-level probe read as the login shell, so a
    /// refusal can name it. Purely cosmetic; it never permits a run.
    pub fn with_known_shell(mut self, shell: Option<String>) -> Self {
        self.known_shell = shell;
        self
    }

    fn emit(&self, phase: &str, step_id: Option<&str>, detail: impl Into<String>) {
        self.emit_step(phase, step_id, None, None, detail);
    }

    fn emit_step(
        &self,
        phase: &str,
        step_id: Option<&str>,
        step_kind: Option<&str>,
        step_secs: Option<u64>,
        detail: impl Into<String>,
    ) {
        self.events.progress(SkillProgress {
            run_id: self.meta.run_id.clone(),
            host_id: self.meta.host_id,
            label: self.meta.label.clone(),
            session_id: self.meta.session_id.clone(),
            step_id: step_id.map(str::to_string),
            phase: phase.into(),
            step_kind: step_kind.map(str::to_string),
            step_secs,
            detail: detail.into(),
            is_root: self.is_root,
        });
    }

    fn send_bytes(&self, text: &str) -> AppResult<()> {
        (self.link.write)(text.as_bytes())
    }

    /// Identifies the running shell before any step runs, so an unsupported one
    /// is refused up front rather than silently mis-executing.
    pub async fn detect_shell(&mut self) -> Result<String, String> {
        // A leading space keeps this out of shell history on the Debian/Ubuntu
        // default (HISTCONTROL=ignoreboth), since an operator pressing Up in the
        // pane afterwards shouldn't find our plumbing.
        let probe = format!(" printf '{SHELL_MARKER}%s__\\n' \"$0\"\n");
        if let Err(e) = self.send_bytes(&probe) {
            return Err(format!("could not write to the shell: {e}"));
        }
        let re = Regex::new(&format!("{SHELL_MARKER}([A-Za-z0-9._/-]*)__")).expect("static regex");
        let outcome = wait_for(
            &mut self.screen,
            &mut self.link.rx,
            &mut self.ctl,
            &re,
            Duration::from_secs(SHELL_DETECT_SECS),
            Duration::ZERO,
        )
        .await;
        let raw = match outcome {
            Wait::Matched { group1, .. } => group1.unwrap_or_default(),
            Wait::Timeout => {
                // A shell that never answered. If the connect-time probe read a
                // name, that IS the answer: fish gets here every time, because
                // `$0` is a parse error there rather than a variable.
                return Err(match &self.known_shell {
                    Some(shell) => format!(
                        "This host's shell ({shell}) is not supported. Currently only bash, zsh and sh are supported."
                    ),
                    None => "Could not identify this host's shell. Currently only bash, zsh and sh are supported."
                        .into(),
                });
            }
            _ => return Err("The shell closed before the run started.".into()),
        };
        // `$0` is `-bash` for a login shell, `/bin/zsh` for some, `sh` for
        // others: take the basename and drop the login dash.
        let name = raw
            .rsplit('/')
            .next()
            .unwrap_or(&raw)
            .trim_start_matches('-')
            .to_string();
        if !SUPPORTED_SHELLS.contains(&name.as_str()) {
            // Prefer a name we actually read over an empty capture.
            let fallback = self.known_shell.as_deref().unwrap_or("unknown");
            let shown = if name.is_empty() { fallback } else { &name };
            return Err(format!(
                "This host's shell ({shown}) is not supported. Currently only bash, zsh and sh are supported."
            ));
        }
        Ok(name)
    }

    /// Probes the shell's effective uid so the panel can warn before a root
    /// shell is handed to a terminal tab or left open. Reuses the marker trick
    /// from `detect_shell`, and like it must only be called at a clean prompt
    /// (never mid-step or while parked): the probe *types* into the shell, so
    /// running it at a half-finished line would corrupt it. Best-effort: any
    /// failure yields `None` (unknown), never an error that ends the run.
    async fn probe_uid(&mut self) -> Option<bool> {
        let probe = format!(" printf '{UID_MARKER}%s__\\n' \"$(id -u)\"\n");
        if self.send_bytes(&probe).is_err() {
            return None;
        }
        let re = Regex::new(&format!(r"{UID_MARKER}(\d+)__")).expect("static regex");
        let outcome = wait_for(
            &mut self.screen,
            &mut self.link.rx,
            &mut self.ctl,
            &re,
            Duration::from_secs(UID_PROBE_SECS),
            Duration::ZERO,
        )
        .await;
        match outcome {
            Wait::Matched { group1, .. } => group1.map(|g| g == "0"),
            _ => None,
        }
    }

    /// Keeps reading until the host goes quiet, so whatever the last step
    /// provoked reaches the pane before the shell is closed.
    ///
    /// The pane renders from the raw `pty:data` stream and does not need the
    /// engine to be listening, but it does need the session to still be open,
    /// and the caller closes it the moment this returns.
    pub async fn linger(&mut self) {
        let _ = wait_quiet(
            &mut self.screen,
            &mut self.link.rx,
            &mut self.ctl,
            LINGER_QUIET,
            LINGER_MAX,
        )
        .await;
    }

    /// Drives the sequence to completion, from `startStepId` until a branch
    /// reaches `stop` (or something goes wrong).
    pub async fn run_sequence(&mut self, cfg: &SequenceConfig) -> HostOutcome {
        let mut current = cfg.start_step_id.clone();
        let mut executions = 0usize;
        loop {
            if current == STOP {
                return HostOutcome::finished(true, "finished");
            }
            let Some(step) = cfg.step(&current) else {
                return HostOutcome::finished(false, format!("step not found: {current}"));
            };
            executions += 1;
            if executions > MAX_STEP_EXECUTIONS {
                // A branch cycle that never converges. Save-time validation
                // allows cycles (polling until ready is legitimate); this is
                // what stops a runaway.
                return HostOutcome::finished(
                    false,
                    format!(
                        "stopped after {MAX_STEP_EXECUTIONS} steps: the skill's branches loop without finishing"
                    ),
                );
            }
            self.emit_step(
                "step",
                Some(step.id()),
                Some(step.kind_str()),
                step.countdown_secs(),
                step.summary(),
            );
            let was_wait = matches!(step, SeqStep::Wait { .. });
            match self.exec_step(step).await {
                StepOutcome::Goto(next) => {
                    // A small, fixed breather between steps, so a step's last
                    // bytes have landed and the shell is back at a prompt before
                    // the next command is typed. Not configurable by design;
                    // it is part of how the engine paces itself. Skipped after a
                    // wait step (it was already a deliberate delay) and when the
                    // run is finishing (`stop` has no next step to pace into).
                    if next != STOP && !was_wait {
                        tokio::time::sleep(STEP_GAP).await;
                    }
                    current = next;
                }
                StepOutcome::Failed(message) => {
                    self.emit("failed", Some(step.id()), message.clone());
                    return HostOutcome::finished(false, message);
                }
                StepOutcome::Aborted => {
                    return HostOutcome {
                        ok: false,
                        message: "stopped by the operator".into(),
                        disposition: Disposition::Aborted,
                        is_root: None,
                    }
                }
                StepOutcome::Detached => {
                    return HostOutcome {
                        ok: true,
                        message: "handed off to a terminal tab".into(),
                        disposition: Disposition::Detached,
                        is_root: None,
                    }
                }
                StepOutcome::Closed => {
                    // The shell is already gone; keep-open is a no-op, so treat
                    // it as a natural (failed) end rather than a close request.
                    return HostOutcome::finished(false, "the shell closed unexpectedly");
                }
            }
        }
    }

    async fn exec_step(&mut self, step: &SeqStep) -> StepOutcome {
        match step {
            SeqStep::Send { input, next, .. } => match self.send_bytes(input) {
                Ok(()) => {
                    self.emit("sent", Some(step.id()), step.summary());
                    StepOutcome::Goto(next.clone())
                }
                Err(e) => StepOutcome::Failed(format!("could not send: {e}")),
            },
            SeqStep::Wait { next, .. } => {
                let duration = step.wait_duration().expect("wait step has a duration");
                // Keep draining output into the screen while we hold, so the
                // buffer stays bounded and the live pane keeps rendering the
                // previous step's screen (a redrawing monitor keeps moving).
                match wait_fixed(
                    &mut self.screen,
                    &mut self.link.rx,
                    &mut self.ctl,
                    duration,
                )
                .await
                {
                    // Elapsed, or the operator skipped ahead: move on.
                    Wait::Timeout | Wait::Skipped => {
                        self.emit("info", Some(step.id()), "done waiting");
                        StepOutcome::Goto(next.clone())
                    }
                    Wait::Aborted => StepOutcome::Aborted,
                    Wait::Detached => StepOutcome::Detached,
                    Wait::Closed => StepOutcome::Closed,
                    // wait_fixed never matches a pattern.
                    Wait::Matched { .. } => StepOutcome::Goto(next.clone()),
                }
            }
            SeqStep::Expect {
                pattern,
                send_on_match,
                on_match,
                ..
            } => {
                let re = match config::compile_pattern(pattern) {
                    Ok(re) => re,
                    Err(e) => return StepOutcome::Failed(e.to_string()),
                };
                match self.wait_with_pause(step, &re, SETTLE, pattern).await {
                    Ok(Wait::Matched { .. }) => {
                        if let Some(text) = send_on_match {
                            if let Err(e) = self.send_bytes(text) {
                                return StepOutcome::Failed(format!("could not send: {e}"));
                            }
                            self.emit("sent", Some(step.id()), format!("answered: {pattern}"));
                        } else {
                            self.emit("matched", Some(step.id()), format!("saw: {pattern}"));
                        }
                        StepOutcome::Goto(on_match.clone())
                    }
                    // Skipping an expect step means "pretend it matched".
                    Ok(Wait::Skipped) => StepOutcome::Goto(on_match.clone()),
                    Ok(Wait::Timeout) => StepOutcome::Failed(format!(
                        "timed out waiting for: {pattern}"
                    )),
                    Ok(Wait::Aborted) => StepOutcome::Aborted,
                    Ok(Wait::Detached) => StepOutcome::Detached,
                    Ok(Wait::Closed) => StepOutcome::Closed,
                    Err(outcome) => outcome,
                }
            }
            SeqStep::Run {
                command,
                interactive,
                on_success,
                on_failure,
                r#match,
                ..
            } => {
                self.run_command_step(step, command, *interactive, on_success, on_failure, r#match)
                    .await
            }
        }
    }

    async fn run_command_step(
        &mut self,
        step: &SeqStep,
        command: &str,
        interactive: bool,
        on_success: &str,
        on_failure: &str,
        branch: &Option<config::MatchBranch>,
    ) -> StepOutcome {
        // A trailing semicolon would collide with the marker we append.
        let cmd = command.trim().trim_end_matches(';').trim();
        if cmd.is_empty() {
            return StepOutcome::Failed("step has an empty command".into());
        }

        if interactive {
            // No completion marker: the command never returns to the prompt on
            // its own (`sudo -i` opens a nested shell; `cpilot` stops on a
            // question). Send it, let the output settle, which also gives the
            // sudo injector time to answer a password prompt before we type
            // anything else at it, then hand over to expect/send steps.
            if let Err(e) = self.send_bytes(&format!(" {cmd}\n")) {
                return StepOutcome::Failed(format!("could not send: {e}"));
            }
            match wait_quiet(
                &mut self.screen,
                &mut self.link.rx,
                &mut self.ctl,
                INTERACTIVE_QUIET,
                Duration::from_secs(step.timeout_secs()),
            )
            .await
            {
                Wait::Aborted => return StepOutcome::Aborted,
                Wait::Detached => return StepOutcome::Detached,
                Wait::Closed => return StepOutcome::Closed,
                _ => return StepOutcome::Goto(on_success.to_string()),
            }
        }

        let wrapped = format!(" {cmd}; printf '{DONE_MARKER}%s__\\n' \"$?\"\n");
        if let Err(e) = self.send_bytes(&wrapped) {
            return StepOutcome::Failed(format!("could not send: {e}"));
        }
        let re = Regex::new(&format!(r"{DONE_MARKER}(\d+)__")).expect("static regex");
        // No settle: the marker is unambiguous the moment it lands, and a
        // settle here would tax every step with latency for nothing.
        match self
            .wait_with_pause(step, &re, Duration::ZERO, "the command to finish")
            .await
        {
            Ok(Wait::Matched { consumed, group1 }) => {
                let code: u32 = group1.and_then(|g| g.parse().ok()).unwrap_or(1);
                let output = command_output(&consumed);
                let Some(b) = branch else {
                    self.emit("matched", Some(step.id()), format!("exit {code}"));
                    return StepOutcome::Goto(if code == 0 {
                        on_success.to_string()
                    } else {
                        on_failure.to_string()
                    });
                };
                // An output test outranks the exit code when the author set one.
                let re = match config::compile_pattern(&b.pattern) {
                    Ok(re) => re,
                    Err(e) => return StepOutcome::Failed(e.to_string()),
                };
                let hit = re.is_match(output);
                self.emit(
                    "matched",
                    Some(step.id()),
                    format!(
                        "exit {code}; output {} {}",
                        if hit { "matched" } else { "did not match" },
                        b.pattern
                    ),
                );
                StepOutcome::Goto(if hit {
                    b.if_match.clone()
                } else {
                    b.if_no_match.clone()
                })
            }
            // Skipping a run step takes its success branch.
            Ok(Wait::Skipped) => StepOutcome::Goto(on_success.to_string()),
            Ok(Wait::Timeout) => {
                // onTimeout: "fail" on a run step takes the failure branch
                // rather than ending the host: the skill author gets to
                // handle it.
                self.emit(
                    "timeout",
                    Some(step.id()),
                    format!("timed out after {}s", step.timeout_secs()),
                );
                StepOutcome::Goto(on_failure.to_string())
            }
            Ok(Wait::Aborted) => StepOutcome::Aborted,
            Ok(Wait::Detached) => StepOutcome::Detached,
            Ok(Wait::Closed) => StepOutcome::Closed,
            Err(outcome) => outcome,
        }
    }

    /// Waits for `re`, handling a timeout per the step's `onTimeout`: `fail`
    /// returns [`Wait::Timeout`] for the caller to branch on, `pause` hands the
    /// host to the operator and then honours what they choose.
    ///
    /// On resume the wait is re-entered but **nothing is re-sent**. A `run`
    /// step's command is still running out there, and re-issuing an `apt
    /// upgrade` because it was slow would be its own disaster.
    async fn wait_with_pause(
        &mut self,
        step: &SeqStep,
        re: &Regex,
        settle: Duration,
        what: &str,
    ) -> Result<Wait, StepOutcome> {
        let timeout = Duration::from_secs(step.timeout_secs());
        loop {
            let outcome = wait_for(
                &mut self.screen,
                &mut self.link.rx,
                &mut self.ctl,
                re,
                timeout,
                settle,
            )
            .await;
            let Wait::Timeout = outcome else {
                return Ok(outcome);
            };
            if step.on_timeout() == TimeoutAction::Fail {
                return Ok(Wait::Timeout);
            }
            let reason = format!("waited {}s for {what}", step.timeout_secs());
            self.emit("timeout", Some(step.id()), reason.clone());
            self.events.paused(SkillPaused {
                run_id: self.meta.run_id.clone(),
                host_id: self.meta.host_id,
                label: self.meta.label.clone(),
                session_id: self.meta.session_id.clone(),
                step_id: step.id().to_string(),
                reason,
            });
            match park(&mut self.screen, &mut self.link.rx, &mut self.ctl).await {
                Park::Resume { clear } => {
                    // Clear only when the operator typed during the pause:
                    // their keystrokes (and whatever they printed) must not
                    // satisfy the pattern we're about to wait for again. When
                    // they only watched, the buffer keeps what the host printed
                    // while parked, so a value that arrived late matches the
                    // retried wait immediately instead of timing out again.
                    if clear {
                        self.screen.clear();
                    }
                    self.emit("info", Some(step.id()), "resumed by the operator");
                }
                Park::Skip => return Ok(Wait::Skipped),
                Park::Abort => return Err(StepOutcome::Aborted),
                Park::Detach => return Err(StepOutcome::Detached),
                Park::Closed => return Err(StepOutcome::Closed),
            }
        }
    }
}

/// Strips the echoed command line and the trailing marker line, leaving what
/// the command actually printed.
///
/// Without this, a `match` pattern would happily match the command's own echo:
/// a step running `grep error log` and branching on `error` would take the
/// match branch every time, whether or not the file contained anything.
fn command_output(consumed: &str) -> &str {
    let mut s = consumed;
    // The echo is identifiable by the literal format string, which only ever
    // appears there (real output carries digits). A long command wraps across
    // tty lines, so cutting at the first newline after the marker can strand
    // the rest of the echo in the output, so anchor on the wrapper's tail (`"$?"`,
    // always the last thing on the line) and cut after the line *that* lands on.
    // Searching forward from the marker means a user command containing its own
    // `"$?"` can't be mistaken for the wrapper's.
    let echo = format!("{DONE_MARKER}%s__");
    if let Some(pos) = s.find(&echo) {
        let tail = s[pos..].find(r#""$?""#).map_or(pos, |i| pos + i);
        if let Some(nl) = s[tail..].find('\n') {
            s = &s[tail + nl + 1..];
        }
    }
    // Drop the marker's own line off the tail.
    if let Some(pos) = s.rfind(DONE_MARKER) {
        let line_start = s[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
        s = &s[..line_start];
    }
    s
}

/// Waits until `re` matches the screen, or the deadline passes.
///
/// Matching is event-driven: evaluated on entry (text may already have
/// arrived) and after each chunk, not polled. Free-standing rather than a
/// method so the three borrows it needs are provably disjoint.
async fn wait_for(
    screen: &mut Screen,
    rx: &mut mpsc::UnboundedReceiver<TapMsg>,
    ctl: &mut mpsc::UnboundedReceiver<Ctl>,
    re: &Regex,
    timeout: Duration,
    settle: Duration,
) -> Wait {
    let deadline = Instant::now() + timeout;
    let mut settle_at: Option<Instant> = None;
    loop {
        if settle_at.is_none() && re.is_match(screen.view()) {
            if settle.is_zero() {
                return take_match(screen, re);
            }
            settle_at = Some(Instant::now() + settle);
        }
        // Parked far enough out to never fire; the `if` guard is what actually
        // enables this branch.
        let settle_deadline = settle_at.unwrap_or_else(|| deadline + Duration::from_secs(1));
        tokio::select! {
            _ = tokio::time::sleep_until(settle_deadline), if settle_at.is_some() => {
                if re.is_match(screen.view()) {
                    return take_match(screen, re);
                }
                // The text was transient: a repaint blew it away. Keep waiting.
                settle_at = None;
            }
            _ = tokio::time::sleep_until(deadline) => return Wait::Timeout,
            msg = rx.recv() => match msg {
                Some(TapMsg::Data(bytes)) => screen.feed(&bytes),
                Some(TapMsg::Closed) | None => return Wait::Closed,
            },
            c = ctl.recv() => match c {
                Some(Ctl::SkipStep) => return Wait::Skipped,
                // A dropped control channel is a cancelled run.
                Some(Ctl::Abort) | None => return Wait::Aborted,
                // Stop driving, but hand the shell off rather than close it.
                Some(Ctl::Detach) => return Wait::Detached,
                // Resume with nothing to resume from: ignore.
                Some(Ctl::Resume { .. }) => {}
            },
        }
    }
}

fn take_match(screen: &mut Screen, re: &Regex) -> Wait {
    let (end, group1) = {
        let view = screen.view();
        match re.captures(view) {
            Some(c) => (
                c.get(0).expect("group 0 always exists").end(),
                c.get(1).map(|m| m.as_str().to_string()),
            ),
            None => return Wait::Timeout,
        }
    };
    Wait::Matched {
        consumed: screen.consume_through(end),
        group1,
    }
}

/// Waits for `quiet` of no output, bounded by `timeout`. How an interactive
/// `run` step decides its command has settled enough to drive.
async fn wait_quiet(
    screen: &mut Screen,
    rx: &mut mpsc::UnboundedReceiver<TapMsg>,
    ctl: &mut mpsc::UnboundedReceiver<Ctl>,
    quiet: Duration,
    timeout: Duration,
) -> Wait {
    let deadline = Instant::now() + timeout;
    let mut quiet_at = Instant::now() + quiet;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(quiet_at) => return Wait::Timeout,
            _ = tokio::time::sleep_until(deadline) => return Wait::Timeout,
            msg = rx.recv() => match msg {
                Some(TapMsg::Data(bytes)) => {
                    screen.feed(&bytes);
                    quiet_at = Instant::now() + quiet;
                }
                Some(TapMsg::Closed) | None => return Wait::Closed,
            },
            c = ctl.recv() => match c {
                Some(Ctl::SkipStep) => return Wait::Skipped,
                Some(Ctl::Abort) | None => return Wait::Aborted,
                // Stop driving, but hand the shell off rather than close it.
                Some(Ctl::Detach) => return Wait::Detached,
                Some(Ctl::Resume { .. }) => {}
            },
        }
    }
}

/// Waits a fixed duration, draining output the whole time so the buffer stays
/// bounded and the live pane keeps rendering. Skip jumps to the end early;
/// abort and a closed shell end the host.
async fn wait_fixed(
    screen: &mut Screen,
    rx: &mut mpsc::UnboundedReceiver<TapMsg>,
    ctl: &mut mpsc::UnboundedReceiver<Ctl>,
    duration: Duration,
) -> Wait {
    let deadline = Instant::now() + duration;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Wait::Timeout,
            msg = rx.recv() => match msg {
                Some(TapMsg::Data(bytes)) => screen.feed(&bytes),
                Some(TapMsg::Closed) | None => return Wait::Closed,
            },
            c = ctl.recv() => match c {
                Some(Ctl::SkipStep) => return Wait::Skipped,
                Some(Ctl::Abort) | None => return Wait::Aborted,
                // Stop driving, but hand the shell off rather than close it.
                Some(Ctl::Detach) => return Wait::Detached,
                // A resume during a plain wait has nothing to resume.
                Some(Ctl::Resume { .. }) => {}
            },
        }
    }
}

/// Holds the host while the operator takes over the live pane. Automation is
/// suspended for the duration (the engine sends nothing until they choose),
/// so there is no race between their keystrokes and the engine's next send.
/// Their traffic still feeds the screen (and the pane), and is cleared on
/// resume.
async fn park(
    screen: &mut Screen,
    rx: &mut mpsc::UnboundedReceiver<TapMsg>,
    ctl: &mut mpsc::UnboundedReceiver<Ctl>,
) -> Park {
    loop {
        tokio::select! {
            c = ctl.recv() => return match c {
                Some(Ctl::Resume { clear }) => Park::Resume { clear },
                Some(Ctl::SkipStep) => Park::Skip,
                Some(Ctl::Abort) | None => Park::Abort,
                Some(Ctl::Detach) => Park::Detach,
            },
            msg = rx.recv() => match msg {
                Some(TapMsg::Data(bytes)) => screen.feed(&bytes),
                Some(TapMsg::Closed) | None => return Park::Closed,
            },
        }
    }
}

/// A [`PtyEvents`](crate::ssh::pty::PtyEvents) sink that forwards every event
/// to the app *and* copies the output bytes to an engine.
///
/// This is what lets a skill run reuse `pty.rs` verbatim: the session task
/// doesn't know it's being driven by a machine, the live pane renders every
/// byte exactly as it would for a terminal tab, and the engine matches against
/// the same stream the operator is watching. Sudo auto-fill, the block feed and
/// the audit trail all keep working because every other event is passed
/// straight through to the AppHandle's own implementation.
struct SkillTap {
    app: tauri::AppHandle,
    tx: mpsc::UnboundedSender<TapMsg>,
}

impl crate::ssh::pty::PtyEvents for SkillTap {
    fn data(&self, payload: crate::ssh::pty::PtyData) {
        use base64::Engine as _;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(&payload.data_b64) {
            let _ = self.tx.send(TapMsg::Data(bytes));
        }
        self.app.data(payload);
    }
    fn closed(&self, payload: crate::ssh::pty::PtyClosed) {
        let _ = self.tx.send(TapMsg::Closed);
        self.app.closed(payload);
    }
    fn block(&self, payload: crate::ssh::pty::PtyBlock) {
        self.app.block(payload);
    }
    fn sudo_injected(&self, payload: crate::ssh::pty::SudoInjected) {
        self.app.sudo_injected(payload);
    }
    fn sudo_rejected(&self, payload: crate::ssh::pty::SudoInjected) {
        self.app.sudo_rejected(payload);
    }
}

/// Builds the engine's half of a PTY session and the event sink to hand
/// [`pty::open`](crate::ssh::pty::open).
pub fn tap(
    app: tauri::AppHandle,
    session_id: String,
) -> (PtyLink, impl crate::ssh::pty::PtyEvents) {
    let (tx, rx) = mpsc::unbounded_channel();
    let write_state = app.state::<crate::ssh::pty::PtyState>().inner().clone();
    let link = PtyLink {
        rx,
        write: Box::new(move |bytes: &[u8]| write_state.write(&session_id, bytes)),
    };
    (link, SkillTap { app, tx })
}

/// Hosts whose steps need a sudo password but have none stored, surfaced as a
/// pre-run warning, since those steps will fail on the far side.
pub fn needs_sudo_password(cfg: &SequenceConfig) -> bool {
    cfg.dispatched_text()
        .iter()
        .any(|text| guard_needs_password(text))
}

fn guard_needs_password(text: &str) -> bool {
    // Only a detector. See the module docs on why the PTY path never applies
    // the rewrite itself.
    crate::guard::rewrite_for_sudo(text).needs_password
}

/// How long to keep reading after the last step, so the host's reply to it
/// actually reaches the pane before the shell is closed.
const LINGER_QUIET: Duration = Duration::from_millis(700);
const LINGER_MAX: Duration = Duration::from_secs(5);

/// Runs one host end to end: identify the shell, drive the sequence, and hand
/// back what happened.
///
/// Deliberately does not emit `done`: the caller owns that, so that a panic in
/// here still reports an outcome rather than stranding the run.
pub async fn run_host<E: SkillEvents>(
    mut engine: Engine<E>,
    cfg: &SequenceConfig,
) -> HostOutcome {
    let mut outcome = match engine.detect_shell().await {
        Ok(shell) => {
            // Probe uid at the clean opening prompt, so `started` (and every
            // later event) carries the login privilege level. A mid-run
            // `sudo -i` is caught by the finish probe below. Only skills that
            // allow transfer keep a shell open, so only they can leave a root
            // shell standing: for every other skill the probe is unused and its
            // echoed `printf ... id -u` line is just noise, so skip it entirely.
            if cfg.allow_transfer {
                engine.is_root = engine.probe_uid().await;
            }
            engine.emit("started", None, format!("shell: {shell}"));
            engine.run_sequence(cfg).await
        }
        Err(message) => return HostOutcome::finished(false, message),
    };
    // A detached shell is handed straight to the operator: don't linger reading
    // it (they own the keyboard now), and don't probe (they may be mid-command).
    if outcome.disposition != Disposition::Detached {
        // The last step's answer only just went out, and the shell may be closed
        // the moment we return. Without this the reply to it never arrives: a
        // sequence ending in "answer the prompt" showed the operator the prompt
        // and nothing else, and the only way to see the result was to add a
        // throwaway step after it.
        engine.linger().await;
        // Re-probe at the clean end-of-run prompt to catch a mid-run escalation
        // (`sudo -i`). Only overwrite on a definite answer. Gated on
        // `allow_transfer` for the same reason as the opening probe: a shell
        // that is about to close has no root status worth warning about.
        if cfg.allow_transfer {
            if let Some(root) = engine.probe_uid().await {
                engine.is_root = Some(root);
            }
        }
    }
    outcome.is_root = engine.is_root;
    outcome
}

/// Turns a `{{param}}`-bearing config plus the user's values into the config
/// the engine actually runs, refusing a broken graph before a single byte is
/// typed at a host.
pub fn prepare(
    cfg: &SequenceConfig,
    supplied: &std::collections::HashMap<String, String>,
) -> AppResult<SequenceConfig> {
    let values = config::resolve_params(&cfg.params, supplied)?;
    let substituted = config::substituted_config(cfg, &values);
    config::validate_sequence(&substituted)?;
    // Turn every `next` target into the concrete id of the following step, so
    // the engine only ever branches to real ids.
    Ok(config::resolve_next(&substituted))
}

pub fn parse_sequence(config_json: &str) -> AppResult<SequenceConfig> {
    serde_json::from_str(config_json)
        .map_err(|e| AppError::InvalidInput(format!("skill config is malformed: {e}")))
}

#[cfg(test)]
mod tests;
