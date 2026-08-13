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
//!
//! ## Out of the operator's way
//!
//! The operator is watching a real terminal, so what the engine types is theirs
//! to read, and Broadside's own bookkeeping is not. Two things keep it off the
//! glass:
//!
//! - A `run` step's command goes out **plain**, with nothing appended, wherever
//!   the shell can report its own completions through the OSC 133 integration
//!   [`crate::omni`] installs on connect. See [`Engine::quiet_ready`].
//! - The engine's probes are typed plain too, and are kept off the glass on the
//!   way out of Broadside rather than by anything done to the shell. See
//!   [`curtain`].
//!
//! The first degrades rather than breaks: a shell that never installed the
//! hooks (or a nested one that lost them and would not take them back) gets the
//! visible `; printf '__bsdone_%s__\n' "$?"` wrapper that every host used to
//! get. The second does not need to degrade, because it does not ask the shell
//! for anything.
//!
//! Both also have to reckon with the same awkward fact, which is that everything
//! the shell says arrives a round trip after the engine typed. Its answer to the
//! previous line is still on the wire when the next one goes out, so nothing the
//! shell *volunteers* can be taken as being about the shell in front of us now.
//! Every question the engine's decisions rest on is therefore asked and waited
//! for by name.

pub mod config;
pub mod curtain;
pub mod screen;
pub mod state;

use std::collections::HashMap;
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::error::{AppError, AppResult};
use crate::ssh::ShellCapability;
use config::{SeqStep, SequenceConfig, TimeoutAction, STOP};
use curtain::Curtain;
use screen::Screen;
use state::Ctl;

pub const PROGRESS_EVENT: &str = "skill:progress";
pub const PAUSED_EVENT: &str = "skill:paused";
pub const DONE_EVENT: &str = "skill:done";

/// Completion marker for a non-interactive `run` step **on a shell that cannot
/// report its own completions**. The fallback, not the usual path: see
/// [`Engine::quiet_ready`].
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
/// Whether the OSC 133 hooks are in the shell in front of us, `y` or `n`, asked
/// and answered in the same hidden line that offers them.
const HOOK_MARKER: &str = "__bshook_";
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
/// After a run step times out, its command is still running, so the engine
/// interrupts it before moving on. How long output must be quiet for the shell
/// to count as back at a prompt, and the ceiling on waiting for that. Short:
/// this is a Ctrl-C landing at a live prompt, not a command doing work, and a
/// command that ignores the interrupt is not going to be talked round by
/// waiting longer.
const INTERRUPT_QUIET: Duration = Duration::from_millis(400);
const INTERRUPT_MAX: Duration = Duration::from_secs(5);
/// How long the shell has to go quiet after the operator hands it back, and the
/// ceiling on waiting for that. See [`Engine::discard_unsubmitted`], which is
/// where the reasoning for needing this at all lives.
///
/// The quiet window has to outlast a round trip plus a redraw, since that is
/// the thing being absorbed, and the ceiling has to be short enough that a host
/// which never goes quiet (a `tail -f` the operator left running) does not hold
/// the run up. Everything in between is a shell repainting a prompt, which is
/// one small write.
const HANDBACK_QUIET: Duration = Duration::from_millis(500);
const HANDBACK_MAX: Duration = Duration::from_secs(3);

/// How long the curtain stays down after a hidden line has been answered,
/// waiting for the shell to finish redrawing its prompt (see
/// [`Engine::raise_curtain`]).
///
/// This is a backstop and not the mechanism: on any shell running the
/// integration the prompt's own mark lifts the curtain, and it arrives in the
/// same breath as the answer. What this bounds is the shell that answers and
/// then goes quiet, which is a shell that refused the hooks or died mid-line.
/// Long enough to cover a round trip and a prompt, short enough that nobody
/// watches a still pane and wonders.
const CURTAIN_LIFT_MAX: Duration = Duration::from_millis(600);
/// How long a prompt that has announced itself has to finish arriving before
/// the curtain comes down in front of it (see
/// [`Engine::let_the_prompt_finish`]). The gap between the two marks is one
/// `PS1` being written, so this is generous by an order of magnitude and is
/// only ever paid by a shell that opens a prompt and never closes it.
const PROMPT_DRAW_MAX: Duration = Duration::from_millis(400);
/// How long to wait for the shell to say whether the integration hooks are in
/// it. A whole shell startup can be inside this one, since offering the hooks to
/// a nested shell means running a line of shell in it.
const HOOK_ANSWER_MAX: Duration = Duration::from_secs(5);
/// How many times one run will go on offering the hooks to a shell that will not
/// take them. Counted against refusals only: a long skill may legitimately open
/// a nested shell many times, and each one that takes them costs nothing. Two
/// refusals is enough to conclude, and every attempt is a line typed at a host.
const MAX_HOOK_INSTALLS: u8 = 2;
/// How long the engine waits at the start of a run for the login to be over
/// before it types anything.
///
/// It cannot simply start. The connect-time setup line
/// ([`crate::omni::shell_setup_command`]) is written from inside the PTY session
/// task once the login banner has streamed, so the engine is handed a live
/// session a long way before the shell behind it is at a prompt. A line typed
/// into a login that is still running sits in the terminal's input queue until
/// something reads it, and the curtain cannot help with that: it hides the line
/// perfectly well, and the run still stalls waiting for an answer from a shell
/// that has not started listening.
///
/// A shell with the integration announces its first prompt, and that is the
/// signal. A shell without one is waited out instead: quiet for `LOGIN_QUIET`,
/// capped at `LOGIN_MAX`.
const LOGIN_MARK_MAX: Duration = Duration::from_secs(4);
const LOGIN_QUIET: Duration = Duration::from_millis(400);
const LOGIN_MAX: Duration = Duration::from_secs(3);

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
    /// `started` | `step` | `matched` | `sent` | `timeout` | `info` | `warn` |
    /// `failed`. `warn` only ever comes from a `log` step.
    pub phase: String,
    /// The kind of the step now running (`run`/`expect`/`send`/`wait`/`log`),
    /// set only on the event that announces a step, so the run panel can offer
    /// step-specific controls. That event's phase is `step` for every kind
    /// except `log`, which announces itself under its own level's phase so its
    /// message is not posted twice: read this field, not the phase, to tell an
    /// announcement from a mid-step event.
    pub step_kind: Option<String>,
    /// The step's countdown budget in seconds, set on the announcing event: a
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
    pub kind: PauseKind,
}

/// Why a host is parked. Both pauses offer the operator the same shell and the
/// same keyboard; they differ in what `step_id` means, and so in which exits
/// make sense.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PauseKind {
    /// A `wait` step timed out and its on-timeout action is `pause`. `step_id`
    /// is the step that is half-done: Resume retries its pattern, and Skip step
    /// declares it satisfied.
    Timeout,
    /// The operator asked for the keyboard (`Ctl::TakeOver`). `step_id` is the
    /// step that has **not** run yet, so Resume runs it and there is nothing for
    /// Skip step to skip.
    TakeOver,
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
    /// Whether this host still has a shell open now the run is over. False when
    /// it never got one (no credentials, unreachable, key not trusted) and when
    /// the shell was closed on the way out. The panel gates its "To terminal"
    /// button on this: offering to adopt a shell that does not exist is an
    /// invitation to press a button that can only fail.
    pub shell_open: bool,
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
    /// The engine's half of the curtain. Made by [`tap`] alongside the tap's
    /// half so the two are the same one; a curtain the tap does not share is a
    /// curtain that hides nothing.
    pub curtain: Curtain,
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
    Matched {
        consumed: String,
        group1: Option<String>,
        /// Where in `consumed` the command's own output began, when the shell
        /// marked it. Only a completion carries one: a pattern match has no
        /// notion of a command, and the fallback wrapper finds the boundary in
        /// the text instead (see [`command_output`]).
        output_at: Option<usize>,
    },
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
    /// What the connect-time probe concluded about that shell. Lets a host
    /// already known to be undrivable be refused before the `$0` probe is even
    /// sent, instead of after it times out.
    known_capability: Option<ShellCapability>,
    /// Whether this session was given the OSC 133 integration when it opened.
    /// The *resolved* answer, so a host the operator has told Broadside never to
    /// write to is one this engine never offers the hooks to either.
    integration_sent: bool,
    /// A [`Ctl::TakeOver`] that arrived mid-step and is waiting for the gap
    /// before the next one. Kept here rather than acted on where it is read,
    /// because the two places that read the control channel are both inside a
    /// step, and a step is not a safe place to hand the keyboard over.
    take_over: bool,
    /// Whether this host's shell could be reporting its own completions, which
    /// is what lets a command go out with nothing appended to it. Set once the
    /// shell has identified itself; it says the hooks are *possible* here, never
    /// that they are in place.
    hooks_possible: bool,
    /// Whether the shell in front of us has been *proved* to have the hooks
    /// since the last thing that could have changed which shell that is. See
    /// [`Engine::forget_shell`].
    hooks_proven: bool,
    /// How many times this run has been refused the hooks, against
    /// [`MAX_HOOK_INSTALLS`].
    hook_installs: u8,
    /// What the operator is not being shown while the engine asks the shell
    /// something. Shared with the tap, which is the half that does the not
    /// showing. See [`curtain`].
    curtain: Curtain,
}

impl<E: SkillEvents> Engine<E> {
    pub fn new(
        link: PtyLink,
        ctl: mpsc::UnboundedReceiver<Ctl>,
        events: std::sync::Arc<E>,
        meta: HostMeta,
    ) -> Self {
        Self {
            curtain: link.curtain.clone(),
            link,
            ctl,
            screen: Screen::new(),
            events,
            meta,
            is_root: None,
            known_shell: None,
            known_capability: None,
            integration_sent: false,
            take_over: false,
            hooks_possible: false,
            hooks_proven: false,
            hook_installs: 0,
        }
    }


    /// Tells the engine what the SSH-level probe read as the login shell, so a
    /// refusal can name it. Purely cosmetic; it never permits a run.
    pub fn with_known_shell(mut self, shell: Option<String>) -> Self {
        self.known_shell = shell;
        self
    }

    /// Tells the engine what the connect-time probe concluded, so a shell that
    /// already cannot take a skill is refused without typing at it first.
    ///
    /// Like [`with_known_shell`](Self::with_known_shell) this never *permits* a
    /// run: `Full` and `ParseSafe` still go on to the in-shell `$0` probe,
    /// because bash and zsh are not the same set as the shells a skill needs,
    /// and the login shell is not necessarily the shell that answers.
    pub fn with_known_capability(mut self, capability: ShellCapability) -> Self {
        self.known_capability = Some(capability);
        self
    }

    /// Tells the engine whether this session was given the OSC 133 integration
    /// on connect, which is what decides whether a command can be typed plain.
    ///
    /// Separate from [`with_known_capability`](Self::with_known_capability), and
    /// deliberately: that one is the probe's own reading, which is what may
    /// refuse a host, while this one is the resolved answer, which is what was
    /// actually written to it. They differ exactly where the operator has
    /// overridden the probe, and the override is the authority on what may be
    /// typed at their host.
    pub fn with_integration_sent(mut self, sent: bool) -> Self {
        self.integration_sent = sent;
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

    /// Types at the host.
    ///
    /// Submitting a line forgets everything the shell had told us about itself,
    /// because anything typed can start a new shell. A bare control character
    /// (Ctrl-U, Ctrl-C) submits nothing and starts nothing, so it leaves that
    /// knowledge alone.
    fn send_bytes(&mut self, text: &str) -> AppResult<()> {
        if text.contains('\n') {
            self.forget_shell();
        }
        (self.link.write)(text.as_bytes())
    }

    /// Forgets which shell we were talking to.
    ///
    /// Two things go, and they are different in kind. The marks are facts the
    /// shell stated, and a completion left lying about would answer the next
    /// command the instant it went out. The proof that the hooks are live is an
    /// answer about a *shell*, and `sudo -i` is not an edge case here, it is the
    /// first step of most skills: the nested shell it opens has none of them.
    ///
    /// Note what this does **not** try to be: a guarantee about bytes still on
    /// the wire. Arming happens when we type, and the shell we typed over may
    /// still have things to say; its last prompt marker can arrive afterwards
    /// and look for all the world like the new shell's. That is the bug smoke
    /// test 56 hit, and the reason nothing here is trusted as proof any more:
    /// see [`Engine::quiet_ready`].
    fn forget_shell(&mut self) {
        self.screen.arm_marks();
        self.hooks_proven = false;
    }

    /// Types a line of Broadside's own plumbing without the operator watching it
    /// go by.
    ///
    /// One line, typed plain. Nothing is done to the shell to hide it: the
    /// curtain comes down on the way out of Broadside instead, so the echo, the
    /// answer and the shell's redraw of its prompt are simply never forwarded to
    /// the pane. See [`curtain`] for why that replaced an erase typed at the
    /// host, and what it cost.
    ///
    /// The order matters and is the one thing to be careful with: the curtain is
    /// lowered *before* the write, not after, so a shell quick enough to echo
    /// inside the same breath cannot get a byte onto the glass first.
    ///
    /// The caller owns raising it again, because the caller is the one that
    /// knows when its answer has arrived. Every path out of this function that
    /// returns `false` has already raised it: a curtain left down is a pane that
    /// never updates again, which is a far worse failure than a visible probe.
    async fn send_hidden(&mut self, payload: &str) -> bool {
        let end = self.curtain_end();
        let line = match end {
            curtain::End::PromptMark => hidden_line(payload),
            curtain::End::ProbeAnswer => hidden_line_self_repairing(payload),
        };
        self.let_the_prompt_finish().await;
        self.curtain.lower(end);
        if self.send_bytes(&line).is_err() {
            self.raise_curtain().await;
            return false;
        }
        true
    }

    /// Waits for a part-drawn prompt to finish arriving, before anything is
    /// hidden from the operator.
    ///
    /// The curtain drops *everything* from the moment it is lowered, so the one
    /// thing that must not be in flight when it comes down is a prompt the
    /// operator is entitled to see. The engine is told the login is over by the
    /// shell announcing a prompt, and announcing one is the *first* thing it
    /// does: the prompt's text, and the mark on the end of it, are still to
    /// come. Lowering there ate the opening prompt of every run, which is how
    /// this was found.
    ///
    /// Bounded and best-effort. A shell sending no marks at all is never
    /// waiting on anything here, and one that opens prompts without closing
    /// them (a half-installed integration) pays the bound once per hidden line
    /// rather than hanging.
    async fn let_the_prompt_finish(&mut self) {
        if !self.screen.prompt_in_progress() {
            return;
        }
        let deadline = Instant::now() + PROMPT_DRAW_MAX;
        while self.screen.prompt_in_progress() {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return,
                msg = self.link.rx.recv() => match msg {
                    Some(TapMsg::Data(bytes)) => self.screen.feed(&bytes),
                    Some(TapMsg::Closed) | None => return,
                },
            }
        }
    }

    /// Which marker should lift the curtain for the line about to be typed.
    ///
    /// The good answer needs the shell to be sending OSC 133, and the honest
    /// version of "is it" is the same pair [`Engine::wait_for_login`] trusts:
    /// the integration was written to this session, and the connect-time probe
    /// read a shell that installs it. `sh` parses the integration happily and
    /// installs nothing, so it is the case this exists to catch.
    ///
    /// A nested shell opened by a step is covered without asking, because the
    /// line that matters there is [`Engine::install_hooks`], and a shell that
    /// takes the hooks draws its very next prompt with the mark on the end.
    /// One that refuses them sends no mark and is caught by the deadline.
    fn curtain_end(&self) -> curtain::End {
        if self.integration_sent && self.known_capability == Some(ShellCapability::Full) {
            curtain::End::PromptMark
        } else {
            curtain::End::ProbeAnswer
        }
    }

    /// Puts the pane back in the operator's hands, once the shell has finished
    /// saying what it was going to say.
    ///
    /// The answer is not the end of the hidden line. On the
    /// [`End::PromptMark`](curtain::End::PromptMark) path the shell still has to
    /// redraw its prompt, and it is that redraw the curtain is really waiting
    /// for: lifting at the answer would forward the prompt and leave the pane
    /// showing two. So this waits for the mark rather than for the answer, which
    /// is why it is the caller's job and not [`Engine::send_hidden`]'s.
    ///
    /// The wait is bounded by [`CURTAIN_LIFT_MAX`] and the bytes go into the
    /// screen as they arrive, so nothing is lost by waiting here.
    ///
    /// Nothing is repaired when the bound is what ends it, and that is the
    /// deliberate part. A shell that answered and then sent no mark did still
    /// redraw its prompt, and that redraw went under the curtain with
    /// everything else, so the prompt left on the glass is the one the operator
    /// should be looking at. Clearing the row "to be safe" would blank a pane
    /// that was already correct.
    async fn raise_curtain(&mut self) {
        let deadline = Instant::now() + CURTAIN_LIFT_MAX;
        while self.curtain.is_down() {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                msg = self.link.rx.recv() => match msg {
                    Some(TapMsg::Data(bytes)) => self.screen.feed(&bytes),
                    Some(TapMsg::Closed) | None => break,
                },
            }
        }
        self.curtain.raise();
    }

    /// Reads the host until one of the engine's own probes answers, and takes
    /// the answer out of the match view on the way past so a later step cannot
    /// match Broadside's bookkeeping.
    ///
    /// Controls are deliberately not read, for the reason given on
    /// [`Engine::discard_unsubmitted`]: these windows run with the curtain down,
    /// and a Detach honoured in the middle of one would hand the operator a pane
    /// that had stopped drawing.
    async fn hidden_answer(&mut self, re: &Regex, max: Duration) -> Option<String> {
        let deadline = Instant::now() + max;
        loop {
            let hit = {
                let view = self.screen.view();
                re.captures(view).map(|c| {
                    let whole = c.get(0).expect("group 0 always exists");
                    (
                        whole.end(),
                        c.get(1).map(|m| m.as_str().to_string()).unwrap_or_default(),
                    )
                })
            };
            if let Some((end, answer)) = hit {
                self.screen.consume_through(end);
                return Some(answer);
            }
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return None,
                msg = self.link.rx.recv() => match msg {
                    Some(TapMsg::Data(bytes)) => self.screen.feed(&bytes),
                    Some(TapMsg::Closed) | None => return None,
                },
            }
        }
    }

    /// Reads the host until it has been quiet for `quiet`, bounded by `max`,
    /// keeping everything it says.
    ///
    /// Control messages are deliberately not read, for the reason given on
    /// [`Engine::discard_unsubmitted`]: a Stop host that arrives during one of
    /// these short windows stays queued and is honoured by the next wait.
    async fn settle_after(&mut self, quiet: Duration, max: Duration) {
        let deadline = Instant::now() + max;
        // Nothing has arrived yet, so there is nothing to be quiet after: the
        // window opens on the first byte back. Counting from now instead would
        // call a host that simply has a long round trip "finished".
        let mut quiet_at: Option<Instant> = None;
        loop {
            let quiet_deadline = quiet_at.unwrap_or_else(|| deadline + Duration::from_secs(1));
            tokio::select! {
                _ = tokio::time::sleep_until(quiet_deadline), if quiet_at.is_some() => return,
                _ = tokio::time::sleep_until(deadline) => return,
                msg = self.link.rx.recv() => match msg {
                    Some(TapMsg::Data(bytes)) => {
                        self.screen.feed(&bytes);
                        quiet_at = Some(Instant::now() + quiet);
                    }
                    Some(TapMsg::Closed) | None => return,
                },
            }
        }
    }

    /// Reads the host until it announces a prompt, giving up after `max`.
    /// Controls are not read, for the reason on [`Engine::settle_after`].
    async fn wait_for_prompt_mark(&mut self, max: Duration) -> bool {
        let deadline = Instant::now() + max;
        loop {
            if self.screen.saw_prompt() {
                return true;
            }
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => return false,
                msg = self.link.rx.recv() => match msg {
                    Some(TapMsg::Data(bytes)) => self.screen.feed(&bytes),
                    Some(TapMsg::Closed) | None => return false,
                },
            }
        }
    }

    /// Whether the shell in front of us will report this command's completion on
    /// its own, so it can be typed plain.
    ///
    /// The hooks live in a shell, not in a host: the ones installed on connect
    /// are gone the moment a step opens a nested one. So the question has to be
    /// asked again after anything that could have changed shells, and the answer
    /// cannot be a mark the shell happened to emit. Marks arrive a round trip
    /// late, so the *old* shell's last prompt marker lands after we have typed
    /// at the new one and reads as proof about it. That is what hung smoke test
    /// 56: `sudo -i`, a marker from the shell it replaced, and then a command
    /// typed plain at a root shell that had no way to answer it.
    ///
    /// So the proof is an answer, not a sighting, and there are only two of
    /// them:
    ///
    /// - the shell answered [`Engine::install_hooks`] with "the hooks are here",
    ///   in a line we typed and waited on, or
    /// - it reported the *previous* command's completion, which only a hooked
    ///   shell can do and which nothing has been typed over since.
    ///
    /// When neither holds, the hooks are offered to the shell, hidden. If it
    /// will not take them the run falls back to the visible completion marker,
    /// which is what every host did before any of this and still works
    /// everywhere.
    async fn quiet_ready(&mut self) -> bool {
        if !self.hooks_possible {
            return false;
        }
        // Free in the steady state: a run step that read a completion off the
        // shell proved the shell that emitted it, and typed nothing since.
        if self.hooks_proven {
            return true;
        }
        if self.hook_installs >= MAX_HOOK_INSTALLS {
            // Asked twice, refused twice. Stop typing at a shell that does not
            // want them; the wrapper works everywhere.
            self.hooks_possible = false;
            return false;
        }
        self.hook_installs += 1;
        self.hooks_proven = self.install_hooks().await;
        if self.hooks_proven {
            // A shell that took them is not evidence against the next one, and
            // a long skill may open nested shells all day.
            self.hook_installs = 0;
        }
        self.hooks_proven
    }

    /// Offers the OSC 133 hooks to the shell in front of us, and has it say
    /// whether they are there, in the same line.
    ///
    /// The same integration [`crate::omni`] sends on connect, guarded so that
    /// running it twice in one shell is a no-op: without the guard a second
    /// install would prepend `__omni_precmd` to `PROMPT_COMMAND` again and the
    /// shell would report every command finishing twice, which is a stale
    /// completion waiting to answer the *next* command.
    ///
    /// The report on the end is what makes this an answer rather than a hope. It
    /// is printed by the same line that installs them, so it cannot be about
    /// some earlier shell, and it says `y` from a shell that already had them as
    /// readily as from one that has just taken them.
    ///
    /// The install is still redirected to `/dev/null`, though the curtain would
    /// hide whatever it said. Not for the pane's sake any more, but for the
    /// engine's: this is the only payload with a mouth on it (a shell that
    /// chokes on the snippet says so), and its complaint would otherwise land in
    /// the match view where a later step's pattern could find it. The report
    /// stands outside the redirect, because that one has to be heard.
    async fn install_hooks(&mut self) -> bool {
        let report = probe_line(
            HOOK_MARKER,
            "\"$(command -v __omni_precmd >/dev/null 2>&1 && echo y || echo n)\"",
        );
        let line = format!(
            "{{ command -v __omni_precmd >/dev/null 2>&1 || {{ {}; }}; }} >/dev/null 2>&1; {report}",
            crate::omni::SHELL_INTEGRATION
        );
        if !self.send_hidden(&line).await {
            return false;
        }
        let re = Regex::new(&format!("{HOOK_MARKER}([a-z]+)__")).expect("static regex");
        let answer = self.hidden_answer(&re, HOOK_ANSWER_MAX).await;
        // A shell that took them draws its next prompt with the mark on the end,
        // which is what lifts the curtain. One that refused sends no mark, so
        // this is the deadline path, and the row it clears is the prompt the
        // refusing shell is still sitting on.
        self.raise_curtain().await;
        matches!(answer.as_deref(), Some("y"))
    }

    /// Waits for the login to be over before anything is typed at it.
    ///
    /// See [`LOGIN_MARK_MAX`] for why a live session is not the same thing as a
    /// shell that is ready to be typed at.
    async fn wait_for_login(&mut self) {
        // A shell that was given the integration announces its first prompt,
        // which is the exact moment it is listening. Nothing has been typed yet,
        // so there is no older shell whose marker this could be.
        if self.integration_sent
            && self.known_capability == Some(ShellCapability::Full)
            && self.wait_for_prompt_mark(LOGIN_MARK_MAX).await
        {
            return;
        }
        self.settle_after(LOGIN_QUIET, LOGIN_MAX).await;
    }

    /// Identifies the running shell before any step runs, so an unsupported one
    /// is refused up front rather than silently mis-executing.
    pub async fn detect_shell(&mut self) -> Result<String, String> {
        // Refuse a shell the connect-time probe already settled, before typing
        // anything at it. Two reasons, and the second is the important one:
        // the `$0` probe below only catches fish by timing out, which parks the
        // pane on "starting…" for SHELL_DETECT_SECS to reach an answer the host
        // row already had; and on a host that is not running a shell at all
        // (pfSense's console menu) sending the probe is the very thing this
        // whole change exists to stop.
        if let Some(cap) = self.known_capability {
            if !cap.sends_setup() {
                return Err(match &self.known_shell {
                    Some(shell) => format!(
                        "This host's shell ({shell}) is not supported. Currently only bash, zsh and sh are supported."
                    ),
                    None => "Could not identify this host's shell, so nothing was sent to it. Currently only bash, zsh and sh are supported."
                        .into(),
                });
            }
        }
        self.wait_for_login().await;
        let probe = probe_line(SHELL_MARKER, "\"$0\"");
        if !self.send_hidden(&probe).await {
            return Err("could not write to the shell".into());
        }
        let re = Regex::new(&format!("{SHELL_MARKER}([A-Za-z0-9._/-]*)__")).expect("static regex");
        let outcome = wait_for(
            &mut self.screen,
            &mut self.link.rx,
            &mut self.ctl,
            &mut self.take_over,
            Target::Pattern(&re),
            Duration::from_secs(SHELL_DETECT_SECS),
            Duration::ZERO,
        )
        .await;
        // Whatever happened, the operator gets their pane back before this
        // returns. A refusal below ends the run, and a run that ends behind a
        // curtain would leave a pane that never draws again.
        self.raise_curtain().await;
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
            // Closed, aborted, or handed to a terminal tab mid-probe.
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
        // Whether a command may go out plain, with no completion marker for the
        // operator to read. Both halves are needed and neither is enough: the
        // hooks have to have been offered to this session, and only bash and
        // zsh install them when they are. This is the one place the two probes
        // meet: the connect-time one decided what was written, and the `$0` one
        // is the authority on what is reading it.
        self.hooks_possible = self.integration_sent && matches!(name.as_str(), "bash" | "zsh");
        Ok(name)
    }

    /// Probes the shell's effective uid so the panel can warn before a root
    /// shell is handed to a terminal tab or left open. Reuses the marker trick
    /// from `detect_shell`, and like it must only be called at a clean prompt
    /// (never mid-step or while parked): the probe *types* into the shell, so
    /// running it at a half-finished line would corrupt it. Best-effort: any
    /// failure yields `None` (unknown), never an error that ends the run.
    async fn probe_uid(&mut self) -> Option<bool> {
        let probe = probe_line(UID_MARKER, "\"$(id -u)\"");
        if !self.send_hidden(&probe).await {
            return None;
        }
        let re = Regex::new(&format!(r"{UID_MARKER}(\d+)__")).expect("static regex");
        let outcome = wait_for(
            &mut self.screen,
            &mut self.link.rx,
            &mut self.ctl,
            &mut self.take_over,
            Target::Pattern(&re),
            Duration::from_secs(UID_PROBE_SECS),
            Duration::ZERO,
        )
        .await;
        self.raise_curtain().await;
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
            &mut self.take_over,
            LINGER_QUIET,
            LINGER_MAX,
        )
        .await;
    }

    /// Drives the sequence to completion, from `startStepId` until a branch
    /// reaches `stop` (or something goes wrong).
    pub async fn run_sequence(&mut self, cfg: &SequenceConfig) -> HostOutcome {
        let mut current = cfg.start_step_id.clone();
        // How many times each step has run, against the skill's repeat limit.
        // Per step rather than a total, so the message can name the step that
        // is actually spinning, and so a long linear skill is never mistaken
        // for a runaway just for having a lot of steps. It bounds the run just
        // as firmly: nothing may run more than `limit` times.
        // `None` when the author has removed the cap. Then nothing in here ends
        // a looping skill, which is exactly what they asked for, and why the
        // control check below is not optional.
        let limit = cfg.step_repeat_limit();
        let mut runs: HashMap<&str, u32> = HashMap::new();
        loop {
            // Look at the control channel between every pair of steps.
            //
            // Steps normally notice Stop host and the emergency stop while they
            // wait, which is fine as long as they wait. An uncapped skill need
            // not: a `log` step branching back to itself never touches the PTY,
            // so with no cap to end it, that loop would spin with nothing ever
            // reading the operator's instruction, and the one control that is
            // supposed to always work would not. Resume and Skip are dropped
            // here rather than acted on: between steps they refer to a step that
            // has already finished.
            match self.ctl.try_recv() {
                Ok(Ctl::Abort) | Err(mpsc::error::TryRecvError::Disconnected) => {
                    return HostOutcome {
                        ok: false,
                        message: "stopped by the operator".into(),
                        disposition: Disposition::Aborted,
                        is_root: None,
                    }
                }
                Ok(Ctl::Detach) => {
                    return HostOutcome {
                        ok: true,
                        message: "handed off to a terminal tab".into(),
                        disposition: Disposition::Detached,
                        is_root: None,
                    }
                }
                Ok(Ctl::TakeOver) => self.take_over = true,
                Ok(Ctl::Resume { .. }) | Ok(Ctl::SkipStep) => {}
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
            if current == STOP {
                return HostOutcome::finished(true, "finished");
            }
            let Some(step) = cfg.step(&current) else {
                return HostOutcome::finished(false, format!("step not found: {current}"));
            };
            // The one moment nothing is in flight, and so the only safe place to
            // hand the keyboard over: the previous step has settled and the next
            // has not been typed. A request that arrived at any point during the
            // last step lands here.
            if std::mem::take(&mut self.take_over) {
                match self.park_for_take_over(step.id()).await {
                    Ok(()) => {}
                    Err(outcome) => return outcome,
                }
            }
            let count = runs.entry(step.id()).or_insert(0);
            // Saturating, because with no cap this counts for as long as the
            // operator lets the skill run, and an overflow panic would take the
            // host's task down rather than reporting anything.
            *count = count.saturating_add(1);
            if limit.is_some_and(|limit| *count > limit) {
                // A branch cycle that never converges. Save-time validation
                // allows cycles (polling until ready is legitimate); this is
                // what stops a runaway.
                let limit = limit.expect("checked just above");
                return HostOutcome::finished(
                    false,
                    format!(
                        "stopped after step {} ran {limit} times: the skill's branches loop without finishing",
                        step.id()
                    ),
                );
            }
            // A log step's line *is* its announcement. "step log: cancelled
            // itself" followed by "cancelled itself" says the same sentence
            // twice, and the first of the two is untinted, so the one that
            // carries the meaning is the one that reads as boilerplate. So a
            // log step announces itself under its own level's phase, carrying
            // its message, and posts nothing further.
            let (phase, detail) = match step {
                SeqStep::Log { level, message, .. } => (level.phase(), message.clone()),
                _ => ("step", step.summary()),
            };
            self.emit_step(
                phase,
                Some(step.id()),
                Some(step.kind_str()),
                step.countdown_secs(),
                detail,
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
                    // Except for a log step, whose announcement above was
                    // already this message under this same `failed` phase: a
                    // skill that refuses a host says so once.
                    if !matches!(step, SeqStep::Log { .. }) {
                        self.emit("failed", Some(step.id()), message.clone());
                    }
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

    /// Park before `next_step_id` because the operator asked for the keyboard.
    ///
    /// The same park a timed-out `wait` step uses, and deliberately so: the
    /// operator gets the identical set of exits, the panel already knows how to
    /// draw them, and there is one pause concept in this engine rather than two.
    /// What differs is only what it is a pause *before*: a timeout parks with a
    /// step half-done and something to retry, this parks with the next step not
    /// yet typed. `kind` on the event is how the panel tells them apart, and it
    /// is why the panel does not offer **Skip step** here: there is nothing yet
    /// to skip.
    ///
    /// `Ok(())` means carry on and run the step. `Err` carries the outcome the
    /// host ended on.
    async fn park_for_take_over(&mut self, next_step_id: &str) -> Result<(), HostOutcome> {
        let reason = "you have the keyboard. Automation is stopped until you resume.".to_string();
        self.emit("info", Some(next_step_id), "paused for takeover");
        self.events.paused(SkillPaused {
            run_id: self.meta.run_id.clone(),
            host_id: self.meta.host_id,
            label: self.meta.label.clone(),
            session_id: self.meta.session_id.clone(),
            step_id: next_step_id.to_string(),
            reason,
            kind: PauseKind::TakeOver,
        });
        match park(&mut self.screen, &mut self.link.rx, &mut self.ctl).await {
            // Same rule as the timeout pause: only text the operator left
            // unsubmitted has to be taken back off the line and forgotten, so
            // the step that follows cannot match against their keystrokes. If
            // they only read, or ran something and pressed Enter, the line is
            // already clear and the buffer is left alone.
            Park::Resume { clear } => {
                if clear && !self.discard_unsubmitted().await {
                    return Err(HostOutcome::finished(
                        false,
                        "the shell closed unexpectedly",
                    ));
                }
                // Whatever the operator did with the keyboard, what the shell
                // last told us about itself was about the shell they were handed,
                // and they may not be handing back the same one. Forget it and
                // make the next command ask again.
                self.forget_shell();
                self.emit("info", Some(next_step_id), resumed_line(clear));
                Ok(())
            }
            // Skip is treated as a resume. The panel does not offer it in this
            // state, since the step it would skip has not run, so this is only
            // reachable from a stale click; running the step the operator was
            // about to watch is the harmless reading of an ambiguous request.
            Park::Skip => {
                self.emit("info", Some(next_step_id), "resumed by the operator");
                Ok(())
            }
            Park::Abort => Err(HostOutcome {
                ok: false,
                message: "stopped by the operator".into(),
                disposition: Disposition::Aborted,
                is_root: None,
            }),
            Park::Detach => Err(HostOutcome {
                ok: true,
                message: "handed off to a terminal tab".into(),
                disposition: Disposition::Detached,
                is_root: None,
            }),
            Park::Closed => Err(HostOutcome::finished(
                false,
                "the shell closed unexpectedly",
            )),
        }
    }

    /// The operator has left half-typed text on this host's command line and
    /// handed it back. Take it off the line, then forget it.
    ///
    /// Only reached when the resume says so (see [`Ctl::Resume`]'s `clear`), and
    /// the condition is narrow on purpose: unsubmitted text, not typing in
    /// general. A command the operator actually ran is the host talking and its
    /// output is kept, which is the whole of smoke 55-2 D2.
    ///
    /// For the unsubmitted case, emptying the match buffer is the obvious move
    /// and it is not enough, which is what smoke 55 B3 caught and smoke 55-3 B1
    /// caught again: the operator typed the very text the next step was waiting
    /// for, resumed, and the step matched it.
    ///
    /// The clear does work. What it cannot do is un-type anything, and that is
    /// the actual problem. Those keystrokes are still sitting on the host's
    /// command line, unentered, and they cause two separate failures:
    ///
    /// - **A shell reprints that line whenever something asks it to redraw**,
    ///   and handing back asks. The amber bar this pane wears while parked is
    ///   taller than the strip it wears while running, so the pane changes
    ///   height, refits, the new size goes to the host, and the shell repaints
    ///   its prompt with the operator's half-typed text on it. That repaint
    ///   arrives *after* the settle below, not during it, because the pane does
    ///   not shrink until it hears the resume acknowledged, and this function is
    ///   what runs before the acknowledgement. So it always lands in the next
    ///   step's wait, where it matches. No settle window can close that.
    /// - **The next thing the engine types lands on the same line**, because
    ///   commands go out with a leading space and no line kill in front of them.
    ///   The operator's `lmnop` plus the closing uid probe became one line,
    ///   `lmnop printf '__bsuid_%s__\n' "$(id -u)"`, which the shell then ran.
    ///
    /// So the line is killed first (Ctrl-U, the POSIX `kill` character: readline
    /// binds it to `unix-line-discard` in both emacs and vi-insert modes, and a
    /// shell with no line editing at all, like dash, gets the same behaviour
    /// from the tty driver). Not Ctrl-C, which would signal whatever the
    /// operator left running, for the same reason `interrupt_running` is only
    /// ever aimed at a `run` step's own command. The one case it does not cover
    /// is an operator who moved the cursor back into the middle of their text,
    /// since Ctrl-U kills leftwards from the cursor; anything right of it
    /// survives, and that is worth the narrower blast radius.
    ///
    /// Then the buffer is emptied, whatever the shell says while it settles is
    /// swallowed (the kill's own repaint, and any echo still in flight), and it
    /// is emptied again. Bounded at both ends: a host printing continuously
    /// never falls quiet, and waiting for it to would hold the run up for as
    /// long as it kept talking.
    ///
    /// Control messages are deliberately *not* read here. A Stop host pressed
    /// during this half-second stays queued and is honoured by the next wait,
    /// which is where every other control is handled; reading them here would
    /// mean re-implementing all of them for the sake of answering half a second
    /// sooner.
    ///
    /// Returns false if the shell closed while settling, which the caller owns:
    /// this one is deep enough in the middle of things to have no opinion about
    /// how a host should end.
    async fn discard_unsubmitted(&mut self) -> bool {
        if self.send_bytes("\x15").is_err() {
            return false;
        }
        self.screen.clear();
        let deadline = Instant::now() + HANDBACK_MAX;
        let mut quiet_at = Instant::now() + HANDBACK_QUIET;
        let mut alive = true;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(quiet_at) => break,
                _ = tokio::time::sleep_until(deadline) => break,
                msg = self.link.rx.recv() => match msg {
                    // Something is still being repainted. Push the quiet window
                    // ahead of it rather than counting from the resume, so a
                    // redraw that arrives late is still inside the window.
                    Some(TapMsg::Data(_)) => quiet_at = Instant::now() + HANDBACK_QUIET,
                    Some(TapMsg::Closed) | None => {
                        alive = false;
                        break;
                    }
                },
            }
        }
        self.screen.clear();
        alive
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
            SeqStep::Log {
                level,
                message,
                next,
                ..
            } => {
                // Nothing to do: `run_sequence` has already posted the line,
                // which is this step's whole job. All that is left is whether
                // the host carries on.
                //
                // An Error that ends the host ends it as a *failure*, carrying
                // the skill's own words. Without this a skill that decided this
                // host was not for it would finish with a green tick and a
                // "finished", which is exactly the wrong impression: the run
                // panel and the error log should both say what it refused and
                // why.
                if *level == config::LogLevel::Error && next == STOP {
                    return StepOutcome::Failed(message.clone());
                }
                StepOutcome::Goto(next.clone())
            }
            SeqStep::Wait { next, .. } => {
                let duration = step.wait_duration().expect("wait step has a duration");
                // Keep draining output into the screen while we hold, so the
                // buffer stays bounded and the live pane keeps rendering the
                // previous step's screen (a redrawing monitor keeps moving).
                match wait_fixed(
                    &mut self.screen,
                    &mut self.link.rx,
                    &mut self.ctl,
                    &mut self.take_over,
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
                match self
                    .wait_with_pause(step, Target::Pattern(&re), SETTLE, pattern)
                    .await
                {
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
                    // `goto` sends the run down a recovery path instead of
                    // ending the host, which is all an expect timeout could do
                    // before. `fail` keeps failing the host.
                    Ok(Wait::Timeout) if step.on_timeout() == TimeoutAction::Goto => {
                        let target = step.on_timeout_target().to_string();
                        self.emit(
                            "timeout",
                            Some(step.id()),
                            format!(
                                "timed out after {}s waiting for: {pattern}; going to {target}",
                                step.timeout_secs()
                            ),
                        );
                        StepOutcome::Goto(target)
                    }
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
            // its own (`sudo -i` opens a nested shell; `htop` takes over the
            // screen). Send it, let the output settle, which also gives the
            // sudo injector time to answer a password prompt before we type
            // anything else at it, then hand over to expect/send steps.
            if let Err(e) = self.send_bytes(&format!(" {cmd}\n")) {
                return StepOutcome::Failed(format!("could not send: {e}"));
            }
            match wait_quiet(
                &mut self.screen,
                &mut self.link.rx,
                &mut self.ctl,
                &mut self.take_over,
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

        // Ask the shell whether it will account for this command itself. When it
        // will, the command goes out exactly as the author wrote it and the
        // operator reads their own line back; when it won't, the completion
        // marker is appended and they read that too, as they always have.
        let quiet = self.quiet_ready().await;
        let line = if quiet {
            format!(" {cmd}\n")
        } else {
            format!(" {cmd}; printf '{DONE_MARKER}%s__\\n' \"$?\"\n")
        };
        if let Err(e) = self.send_bytes(&line) {
            return StepOutcome::Failed(format!("could not send: {e}"));
        }
        let re = Regex::new(&format!(r"{DONE_MARKER}(\d+)__")).expect("static regex");
        let target = if quiet {
            Target::Done
        } else {
            Target::Pattern(&re)
        };
        // No settle: the marker is unambiguous the moment it lands, and a
        // settle here would tax every step with latency for nothing.
        match self
            .wait_with_pause(step, target, Duration::ZERO, "the command to finish")
            .await
        {
            Ok(Wait::Matched {
                consumed,
                group1,
                output_at,
            }) => {
                // The shell accounted for a command of its own accord, which
                // only a hooked one can do, and nothing has been typed over it
                // since. That is the proof the next step runs on.
                self.hooks_proven = quiet;
                let code: u32 = group1.and_then(|g| g.parse().ok()).unwrap_or(1);
                // Where the command's own output starts, so a `match` test
                // cannot match the command that produced it: a step running
                // `grep error log` and branching on `error` would take the match
                // branch every time. The shell says where when it can, and the
                // text says where when it has to.
                let output = match output_at {
                    Some(at) => &consumed[at..],
                    None => command_output(&consumed),
                };
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
                // A completion arrived, and was refused for having no command in
                // front of it, and then nothing else came. Waiting on this
                // shell's marks is not going to start working, and every
                // remaining step would time out the same way, so take the rest
                // of the run back to the marker that works everywhere.
                if quiet && self.screen.stray_done() {
                    self.hooks_possible = false;
                    self.hooks_proven = false;
                    self.emit(
                        "info",
                        Some(step.id()),
                        "this shell reports completions out of order; using the visible marker from here",
                    );
                }
                // onTimeout: "fail" on a run step takes the failure branch
                // rather than ending the host: the skill author gets to
                // handle it. "goto" takes the timeout target instead, so a
                // timeout can be handled separately from a non-zero exit.
                let target = if step.on_timeout() == TimeoutAction::Goto {
                    step.on_timeout_target().to_string()
                } else {
                    on_failure.to_string()
                };
                // The marker never arrived, so the command is still running and
                // still owns the terminal. Abandoning it in the engine while
                // leaving it running on the host means the next step's command
                // is typed into a busy shell: it sits in the tty buffer behind
                // the old one instead of running, and the step then times out
                // too, for a reason that looks nothing like the real one. So
                // interrupt it and wait for the prompt to come back first.
                match self.interrupt_running().await {
                    Wait::Aborted => return StepOutcome::Aborted,
                    Wait::Detached => return StepOutcome::Detached,
                    Wait::Closed => return StepOutcome::Closed,
                    _ => {}
                }
                self.emit(
                    "timeout",
                    Some(step.id()),
                    format!(
                        "timed out after {}s; interrupted it and went to {target}",
                        step.timeout_secs()
                    ),
                );
                StepOutcome::Goto(target)
            }
            Ok(Wait::Aborted) => StepOutcome::Aborted,
            Ok(Wait::Detached) => StepOutcome::Detached,
            Ok(Wait::Closed) => StepOutcome::Closed,
            Err(outcome) => outcome,
        }
    }

    /// Interrupts the command a timed-out `run` step left running, so the next
    /// step types at a prompt rather than into a busy shell.
    ///
    /// Ctrl-C, then wait for the screen to go quiet. This is exactly what an
    /// operator watching the pane would do, and it is why a shell abandons the
    /// whole command line: the completion marker was appended to the command
    /// with `;`, so it dies with it and no stale marker is left behind to
    /// satisfy the *next* step's wait.
    ///
    /// Best effort, and deliberately so. A command that ignores SIGINT is still
    /// running when this returns, and the following step will queue up behind
    /// it exactly as before. Nothing stronger is attempted: from here the only
    /// escalation is killing the process (or the shell), and a skill that
    /// silently SIGKILLs an upgrade it decided was slow would be far worse than
    /// one that runs on and says where it went.
    ///
    /// Only run steps get this. An `expect` step that times out has not
    /// necessarily started anything: the thing holding the terminal may be a
    /// nested shell or an editor an earlier interactive step opened on purpose,
    /// and Ctrl-C into that is the engine breaking the operator's own setup.
    async fn interrupt_running(&mut self) -> Wait {
        if self.send_bytes("\x03").is_err() {
            return Wait::Closed;
        }
        wait_quiet(
            &mut self.screen,
            &mut self.link.rx,
            &mut self.ctl,
            &mut self.take_over,
            INTERRUPT_QUIET,
            INTERRUPT_MAX,
        )
        .await
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
        target: Target<'_>,
        settle: Duration,
        what: &str,
    ) -> Result<Wait, StepOutcome> {
        let timeout = Duration::from_secs(step.timeout_secs());
        loop {
            let outcome = wait_for(
                &mut self.screen,
                &mut self.link.rx,
                &mut self.ctl,
                &mut self.take_over,
                target,
                timeout,
                settle,
            )
            .await;
            let Wait::Timeout = outcome else {
                return Ok(outcome);
            };
            // Only `pause` parks here. `fail` and `goto` both hand the timeout
            // back to the caller, which knows what its step kind should do with
            // it (branch, jump, or end the host).
            if step.on_timeout() != TimeoutAction::Pause {
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
                kind: PauseKind::Timeout,
            });
            match park(&mut self.screen, &mut self.link.rx, &mut self.ctl).await {
                Park::Resume { clear } => {
                    // Clear only when the operator left text unsubmitted on the
                    // command line: that is the one thing a redraw can reprint
                    // into the pattern we're about to wait for again. When they
                    // only watched, or ran something and pressed Enter, the
                    // buffer keeps what the host printed while parked, so a
                    // value that arrived late matches the retried wait
                    // immediately instead of timing out again.
                    //
                    // Clearing is not the whole of forgetting, and the pattern
                    // this is about to wait for again is exactly the kind a
                    // redraw can satisfy by accident. See `discard_unsubmitted`.
                    if clear && !self.discard_unsubmitted().await {
                        return Err(StepOutcome::Closed);
                    }
                    // See the same line in `park_for_take_over`: the shell they
                    // hand back may not be the one they were given.
                    self.forget_shell();
                    self.emit("info", Some(step.id()), resumed_line(clear));
                    // Re-announce the step, because the wait genuinely restarts
                    // here with a full fresh timeout and the panel's countdown
                    // is keyed off the announcement. Without this it kept
                    // counting from when the step first started, so the second
                    // wait was spent showing a red nought while the engine was
                    // in fact waiting the whole budget again, and the only proof
                    // of that was the timeout arriving at the end of it.
                    self.emit_step(
                        "step",
                        Some(step.id()),
                        Some(step.kind_str()),
                        step.countdown_secs(),
                        step.summary(),
                    );
                }
                Park::Skip => return Ok(Wait::Skipped),
                Park::Abort => return Err(StepOutcome::Aborted),
                Park::Detach => return Err(StepOutcome::Detached),
                Park::Closed => return Err(StepOutcome::Closed),
            }
        }
    }
}

/// One of the engine's probes: `printf` the marker with the shell's answer in
/// it, inside an escape sequence addressed to Broadside rather than to the
/// terminal, so no pane draws it (see [`screen::BS_OSC`]).
///
/// The marker text is inside the payload, not around it, and that is what makes
/// this safe to send anywhere. A shell whose `printf` leaves `\033` alone prints
/// the whole thing literally and the same pattern still matches the same answer
/// out of the visible line. The `%s` matters for the same reason it always did:
/// the echo of this line reaches the engine's match view whether or not it
/// reaches the glass, and a marker with no digit in it can never be mistaken for
/// an answer to itself.
///
/// A leading space is left to the caller, which is [`Engine::send_hidden`]: on
/// the Debian/Ubuntu default (`HISTCONTROL=ignoreboth`) it keeps the line out of
/// shell history, so an operator pressing Up in the pane afterwards doesn't find
/// Broadside's plumbing.
fn probe_line(marker: &str, value: &str) -> String {
    format!(
        "printf '\\033]{};{marker}%s__\\007' {value}",
        screen::BS_OSC
    )
}

/// Put the cursor at the start of the row and clear it.
///
/// The only cursor movement left in the engine, and note what it is not: it does
/// not go *up*. Every erase that counted rows had to be right about how many the
/// plumbing had used, which depends on the width of the pane, the length of the
/// prompt and whether the shell drew the line itself. This one addresses the row
/// the cursor is already on, so there is nothing to be right about.
///
/// It is only sent on the [`End::ProbeAnswer`](curtain::End::ProbeAnswer) path,
/// where the curtain lifts before the shell redraws its prompt and the new
/// prompt would otherwise be drawn onto the end of the old one. A shell sending
/// prompt marks never needs it: there the curtain stays down through the redraw
/// and the pane keeps the prompt it already had.
const ERASE_ROW: &str = r"\r\033[2K";

/// One line of plumbing, as it is typed at a shell that reports its own prompts.
///
/// There is nothing here but the payload. No `stty`, because nothing is being
/// hidden from the *shell*; no erase, because nothing was drawn. The leading
/// space is all that is left of the old ceremony, and it is not about the pane
/// at all: it keeps the line out of `HISTCONTROL=ignorespace` history, so an
/// operator pressing Up afterwards does not find it.
fn hidden_line(payload: &str) -> String {
    format!(" {payload}\n")
}

/// The same, for a shell that sends no prompt marks and so cannot tell us when
/// it has finished redrawing.
///
/// The curtain lifts at the answer, which is before the prompt is drawn, so the
/// line clears the row on its way out and lets the prompt land on it. See
/// [`ERASE_ROW`].
fn hidden_line_self_repairing(payload: &str) -> String {
    format!(" {payload}; printf '{ERASE_ROW}'\n")
}

/// What a wait is waiting for.
///
/// Text and marks are not the same kind of thing, and the difference is why
/// marks have to be armed. A pattern matches a *position* in the stream and is
/// consumed through it, so the same output can never satisfy two steps. A mark
/// has no position: it is a fact the shell stated, and a fact stays true until
/// somebody takes it, so a completion left lying about would answer the next
/// command the instant it was sent.
#[derive(Clone, Copy)]
enum Target<'a> {
    /// Text on the screen.
    Pattern(&'a Regex),
    /// The shell's own "that command finished", carrying its exit status.
    Done,
}

/// What the step log says about a resume.
///
/// When the operator left text unsubmitted, the engine takes it back off the
/// command line, and a line disappearing out of their shell should be accounted
/// for in the log rather than left looking like a glitch.
fn resumed_line(cleared: bool) -> &'static str {
    if cleared {
        "resumed by the operator; the half-typed line was cleared"
    } else {
        "resumed by the operator"
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

/// Waits until `target` arrives on the screen, or the deadline passes.
///
/// Matching is event-driven: evaluated on entry (text may already have
/// arrived) and after each chunk, not polled. Free-standing rather than a
/// method so the three borrows it needs are provably disjoint.
async fn wait_for(
    screen: &mut Screen,
    rx: &mut mpsc::UnboundedReceiver<TapMsg>,
    ctl: &mut mpsc::UnboundedReceiver<Ctl>,
    // `take_over` is set if a Ctl::TakeOver arrives while this wait is running.
    // Read by the caller's caller in the gap between steps, which is where the
    // request is acted on.
    take_over: &mut bool,
    target: Target<'_>,
    timeout: Duration,
    settle: Duration,
) -> Wait {
    let deadline = Instant::now() + timeout;
    let mut settle_at: Option<Instant> = None;
    loop {
        if settle_at.is_none() && arrived(screen, target) {
            if settle.is_zero() {
                return take_match(screen, target);
            }
            settle_at = Some(Instant::now() + settle);
        }
        // Parked far enough out to never fire; the `if` guard is what actually
        // enables this branch.
        let settle_deadline = settle_at.unwrap_or_else(|| deadline + Duration::from_secs(1));
        tokio::select! {
            _ = tokio::time::sleep_until(settle_deadline), if settle_at.is_some() => {
                if arrived(screen, target) {
                    return take_match(screen, target);
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
                // Remembered, not obeyed: the operator asked for the keyboard
                // while this step is mid-flight, and it is handed over in the
                // gap after it rather than into the middle of it. Carrying it
                // out of here is the whole reason this takes a flag.
                Some(Ctl::TakeOver) => *take_over = true,
                // Resume with nothing to resume from: ignore.
                Some(Ctl::Resume { .. }) => {}
            },
        }
    }
}

/// Whether what the wait is waiting for is on the screen now.
fn arrived(screen: &mut Screen, target: Target<'_>) -> bool {
    match target {
        Target::Pattern(re) => re.is_match(screen.view()),
        Target::Done => screen.saw_done(),
    }
}

/// Takes what arrived, and with it whatever text it accounts for.
///
/// A pattern consumes through its own end, so text after it stays matchable. A
/// completion has no position, so it takes the whole view: it is the last thing
/// the shell says about a command, and everything up to it belongs to that
/// command.
fn take_match(screen: &mut Screen, target: Target<'_>) -> Wait {
    let re = match target {
        Target::Pattern(re) => re,
        Target::Done => {
            let group1 = screen.take_done().flatten().map(|code| code.to_string());
            let (consumed, output_at) = screen.take_view();
            return Wait::Matched {
                consumed,
                group1,
                output_at,
            };
        }
    };
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
        output_at: None,
    }
}

/// Waits for `quiet` of no output, bounded by `timeout`. How an interactive
/// `run` step decides its command has settled enough to drive.
async fn wait_quiet(
    screen: &mut Screen,
    rx: &mut mpsc::UnboundedReceiver<TapMsg>,
    ctl: &mut mpsc::UnboundedReceiver<Ctl>,
    take_over: &mut bool,
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
                // Remembered for the gap after this step; see wait_for.
                Some(Ctl::TakeOver) => *take_over = true,
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
    take_over: &mut bool,
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
                // Remembered for the gap after this step; see wait_for.
                Some(Ctl::TakeOver) => *take_over = true,
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
                // Already parked, so the request is already granted: the
                // operator has the keyboard. Nothing to do but keep waiting
                // for the instruction that ends the pause.
                Some(Ctl::TakeOver) => continue,
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
    curtain: Curtain,
}

impl crate::ssh::pty::PtyEvents for SkillTap {
    /// The fork in the road: the engine is told everything, the operator is told
    /// everything the engine is not currently hiding from them.
    ///
    /// The filter runs *before* the send, which is what lets the engine wait on
    /// the curtain: by the time a chunk reaches it on the channel, that chunk
    /// has already been weighed, so a mark inside it has already lifted the
    /// curtain. The other order would have the engine deciding whether to give
    /// up on a mark it was holding in its hand.
    fn data(&self, payload: crate::ssh::pty::PtyData) {
        let shown = self.curtain.filter(&payload.data).to_vec();
        let _ = self.tx.send(TapMsg::Data(payload.data));
        // An empty payload is not a quiet one: it still costs a serialize, a
        // JS string and a hop to the webview, and a curtain that is down makes
        // every chunk empty.
        if !shown.is_empty() {
            self.app.data(crate::ssh::pty::PtyData {
                session_id: payload.session_id,
                data: shown,
            });
        }
    }
    fn flush(&self, session_id: &str) {
        self.app.flush(session_id);
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
    let curtain = Curtain::new();
    let link = PtyLink {
        rx,
        write: Box::new(move |bytes: &[u8]| write_state.write(&session_id, bytes)),
        curtain: curtain.clone(),
    };
    (link, SkillTap { app, tx, curtain })
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
    // Two dispositions skip the tail work entirely.
    //
    // Detached: the shell is handed straight to the operator, so don't linger
    // reading it (they own the keyboard now) and don't probe (they may be
    // mid-command).
    //
    // Aborted: the operator asked for this host to stop, and the shell is about
    // to be closed regardless, so there is nothing the tail could tell anyone.
    // Doing it anyway was actively harmful: `probe_uid` *types* into the shell,
    // and pressing Stop host at a step parked on an unanswered `sudo` password
    // prompt fed the probe line in as a password guess, then sat through its
    // five second wait before the host finally stopped. Stop now means stop now.
    if !matches!(
        outcome.disposition,
        Disposition::Detached | Disposition::Aborted
    ) {
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
mod pane_tests;
#[cfg(test)]
mod tests;
