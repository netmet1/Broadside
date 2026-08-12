//! The live-run registry: `run_id -> per-host control channels`, modeled on
//! [`PtyState`](crate::ssh::pty::PtyState)'s registry.
//!
//! Dropping a host's control sender is itself a signal: the engine's waits
//! treat a closed control channel as an abort, so cancelling a run needs only
//! to drop its entry (and close the PTYs); there is no separate flag for a
//! parked host to miss.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};

/// An operator instruction to one host's engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ctl {
    /// Wait for the current step's pattern again, with a fresh timeout. Does
    /// **not** re-send a `run` step's command: the command is still running;
    /// re-sending it could double-execute an upgrade.
    ///
    /// `clear` says whether the engine should drop its match buffer first, and
    /// the question it answers is narrower than "did the operator type": it is
    /// **is there unsubmitted text sitting on the command line**.
    ///
    /// That is the only thing a hand-back has to forget, and the only thing it
    /// has to undo. Half-typed text is still on the host's line editor,
    /// unentered: the shell reprints it on the next redraw, which is how the
    /// operator's keystrokes ended up satisfying the next step's pattern (smoke
    /// 55 B3, and again in 55-3 B1), and the next command the engine types
    /// lands on the end of it. So that case kills the line, clears, and swallows
    /// what the kill repaints (see `Engine::discard_unsubmitted`).
    ///
    /// Everything else is kept, and both halves of that matter:
    ///
    /// - The operator only watched. The buffer keeps whatever the host printed
    ///   while parked, so a value that arrived late matches the retried wait
    ///   immediately. Clearing here guaranteed a second timeout with the
    ///   awaited text plainly on screen.
    /// - The operator ran a command and pressed Enter. Its output is the host
    ///   talking, not their keystrokes, and the next step is entitled to match
    ///   it. Clearing here threw that output away, usually before the operator
    ///   had even pressed Resume, since a command that runs in a moment has
    ///   already printed by then (smoke 55-2 D2).
    Resume { clear: bool },
    /// Treat the current step as satisfied and take its success branch.
    SkipStep,
    /// The operator wants the keyboard on this host, from the next gap between
    /// steps.
    ///
    /// Deliberately **not** acted on where it is received. Every other control
    /// here answers a host that is already parked and waiting to be told what to
    /// do; this one arrives while the engine is mid-step, and a step is not a
    /// safe place to stop. A `run` step has typed a command that is still
    /// executing, and cutting in there would leave the operator sharing a
    /// keyboard with a command whose output the engine is still matching
    /// against. So the engine remembers the request and parks in the gap before
    /// the next step, which is the one moment nothing is in flight.
    TakeOver,
    /// Stop this host after the current step.
    Abort,
    /// Stop driving this host but leave its shell open, so it can be adopted by
    /// a terminal tab. Like [`Ctl::Abort`] the engine stops, but the PTY is
    /// **not** closed and the session is handed off rather than torn down.
    Detach,
}

struct HostEntry {
    session_id: String,
    ctl: mpsc::UnboundedSender<Ctl>,
    /// Whether the operator has left text unsubmitted on this host's command
    /// line since the last resume. Decides `Ctl::Resume`'s `clear`.
    unsubmitted: bool,
}

#[derive(Default)]
struct RunEntry {
    hosts: HashMap<i64, HostEntry>,
    /// Shells kept open after their host finished (a transfer-enabled skill),
    /// still owned by the run so Close run / emergency stop can close them.
    /// `host_id -> session_id`. Emptied as they are adopted or closed.
    lingering: HashMap<i64, String>,
}

/// Every in-flight skill run. Clone-cheap (shared map) so each host task can
/// deregister itself.
#[derive(Default, Clone)]
pub struct SkillRunState(Arc<Mutex<HashMap<String, RunEntry>>>);

impl SkillRunState {
    /// Registers one host of a run and hands back the control receiver its
    /// engine parks on.
    pub fn register_host(
        &self,
        run_id: &str,
        host_id: i64,
        session_id: &str,
    ) -> mpsc::UnboundedReceiver<Ctl> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut map = self.0.lock().unwrap();
        map.entry(run_id.to_string())
            .or_default()
            .hosts
            .insert(
                host_id,
                HostEntry {
                    session_id: session_id.to_string(),
                    ctl: tx,
                    unsubmitted: false,
                },
            );
        rx
    }

    /// Deregisters a finished host whose shell was closed, and the run itself
    /// once nothing (driven or lingering) is left under it.
    pub fn finish_host(&self, run_id: &str, host_id: i64) {
        let mut map = self.0.lock().unwrap();
        if let Some(run) = map.get_mut(run_id) {
            run.hosts.remove(&host_id);
            if run.hosts.is_empty() && run.lingering.is_empty() {
                map.remove(run_id);
            }
        }
    }

    /// Moves a finished host's still-open shell into the lingering set: its
    /// engine is gone but the PTY stays open, still owned by the run so Close
    /// run (or emergency stop) can close it. Used for transfer-enabled skills.
    pub fn linger_host(&self, run_id: &str, host_id: i64) {
        let mut map = self.0.lock().unwrap();
        if let Some(run) = map.get_mut(run_id) {
            if let Some(entry) = run.hosts.remove(&host_id) {
                run.lingering.insert(host_id, entry.session_id);
            }
        }
    }

    /// Hands a host's shell off to a terminal tab: drop it from the run's
    /// tracking (driven or lingering) **without** closing it, and drop the run
    /// once nothing is left. Called when the engine reports it detached.
    pub fn adopt_host(&self, run_id: &str, host_id: i64) {
        let mut map = self.0.lock().unwrap();
        if let Some(run) = map.get_mut(run_id) {
            run.hosts.remove(&host_id);
            run.lingering.remove(&host_id);
            if run.hosts.is_empty() && run.lingering.is_empty() {
                map.remove(run_id);
            }
        }
    }

    /// The operator asked to send a host's shell to a terminal tab. If the host
    /// is still being driven, tell its engine to detach (stop without closing);
    /// [`adopt_host`](Self::adopt_host) then drops it from tracking when the
    /// engine returns. If it already finished and is lingering, hand it off now.
    /// Either way the frontend adopts the existing session.
    pub fn detach(&self, run_id: &str, host_id: i64) -> AppResult<()> {
        let mut map = self.0.lock().unwrap();
        let run = map.get_mut(run_id).ok_or_else(|| {
            AppError::State(format!("no active skill run {run_id} for host {host_id}"))
        })?;
        if let Some(entry) = run.hosts.get(&host_id) {
            return entry
                .ctl
                .send(Ctl::Detach)
                .map_err(|_| AppError::State("that host's skill run already ended".into()));
        }
        if run.lingering.remove(&host_id).is_some() {
            if run.hosts.is_empty() && run.lingering.is_empty() {
                map.remove(run_id);
            }
            return Ok(());
        }
        Err(AppError::State(format!(
            "no active skill run {run_id} for host {host_id}"
        )))
    }

    /// Sends one instruction to one host.
    pub fn send(&self, run_id: &str, host_id: i64, ctl: Ctl) -> AppResult<()> {
        let map = self.0.lock().unwrap();
        let entry = map
            .get(run_id)
            .and_then(|r| r.hosts.get(&host_id))
            .ok_or_else(|| {
                AppError::State(format!("no active skill run {run_id} for host {host_id}"))
            })?;
        entry
            .ctl
            .send(ctl)
            .map_err(|_| AppError::State("that host's skill run already ended".into()))
    }

    /// The PTY session driving one host, for routing manual-takeover keystrokes.
    /// Also tracks whether those keystrokes have been left unsubmitted, which is
    /// what the next resume clears the match buffer for (see [`Ctl::Resume`]).
    ///
    /// The test is the last thing in the chunk: a trailing Enter means the line
    /// went to the shell and there is nothing left on it to be re-echoed, and
    /// anything else means there is. Keystrokes arrive one at a time from
    /// xterm's `onData`, so the chunk is usually a single character; a paste is
    /// the exception, and reading its last byte is still the right question
    /// ("what is on the line now"), not an approximation of one.
    ///
    /// Editing keys are deliberately not decoded. A Backspace or a Ctrl+C leaves
    /// the flag set even though the line may now be empty, which costs a clear
    /// that was not needed. Decoding them means tracking the line editor's state
    /// from the outside, through a shell's own key bindings, and being wrong at
    /// that is a false match on the operator's typing, which is the bug this
    /// exists to prevent.
    pub fn session_id_for_input(
        &self,
        run_id: &str,
        host_id: i64,
        data: &[u8],
    ) -> AppResult<String> {
        let mut map = self.0.lock().unwrap();
        map.get_mut(run_id)
            .and_then(|r| r.hosts.get_mut(&host_id))
            .map(|h| {
                match data.last() {
                    Some(b'\r') | Some(b'\n') => h.unsubmitted = false,
                    Some(_) => h.unsubmitted = true,
                    // An empty write is not a keystroke and says nothing about
                    // the line either way.
                    None => {}
                }
                h.session_id.clone()
            })
            .ok_or_else(|| {
                AppError::State(format!("no active skill run {run_id} for host {host_id}"))
            })
    }

    /// Resumes a parked host, telling the engine to clear its match buffer only
    /// if the operator left text unsubmitted on the command line since the last
    /// resume (see [`Ctl::Resume`]).
    pub fn resume(&self, run_id: &str, host_id: i64) -> AppResult<()> {
        let mut map = self.0.lock().unwrap();
        let entry = map
            .get_mut(run_id)
            .and_then(|r| r.hosts.get_mut(&host_id))
            .ok_or_else(|| {
                AppError::State(format!("no active skill run {run_id} for host {host_id}"))
            })?;
        let clear = std::mem::take(&mut entry.unsubmitted);
        entry
            .ctl
            .send(Ctl::Resume { clear })
            .map_err(|_| AppError::State("that host's skill run already ended".into()))
    }

    /// Drops the whole run and returns every PTY session id still open under it
    /// (driven **and** lingering) for the caller to close. Dropping the entry
    /// closes every control channel, which every engine, waiting or parked,
    /// reads as an abort. Adopted sessions were already removed, so they survive.
    pub fn cancel(&self, run_id: &str) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .remove(run_id)
            .map(|run| {
                run.hosts
                    .into_values()
                    .map(|h| h.session_id)
                    .chain(run.lingering.into_values())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Closes a finished run: same as [`cancel`](Self::cancel) (drop the run,
    /// return every still-open session id), but named for the deliberate "Close
    /// run" teardown rather than the emergency stop. By this point only
    /// lingering shells remain; adopted ones are gone from tracking.
    pub fn close_run(&self, run_id: &str) -> Vec<String> {
        self.cancel(run_id)
    }

    pub fn is_active(&self, run_id: &str) -> bool {
        self.0.lock().unwrap().contains_key(run_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_then_send_reaches_the_host() {
        let state = SkillRunState::default();
        let mut rx = state.register_host("run1", 7, "sess-7");
        state.send("run1", 7, Ctl::Abort).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Abort);
    }

    #[test]
    fn session_id_round_trips() {
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        assert_eq!(
            state.session_id_for_input("run1", 7, b"x").unwrap(),
            "sess-7"
        );
    }

    #[test]
    fn send_to_an_unknown_run_or_host_errors() {
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        assert!(state.send("nope", 7, Ctl::Abort).is_err());
        assert!(state.send("run1", 99, Ctl::Abort).is_err());
        assert!(state.session_id_for_input("run1", 99, b"x").is_err());
        assert!(state.resume("run1", 99).is_err());
    }

    #[test]
    fn resume_without_typing_does_not_clear() {
        // The slow-host case: the value arrived while parked, nobody typed, so
        // the retried wait must still see it.
        let state = SkillRunState::default();
        let mut rx = state.register_host("run1", 7, "sess-7");
        state.resume("run1", 7).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Resume { clear: false });
    }

    #[test]
    fn resume_after_unsubmitted_typing_clears_once() {
        // Smoke 55 B3: `lnop` is sitting on the command line, unentered, and a
        // redraw will reprint it. That is the one thing the hand-back forgets.
        let state = SkillRunState::default();
        let mut rx = state.register_host("run1", 7, "sess-7");
        for c in [b"l", b"n", b"o", b"p"] {
            state.session_id_for_input("run1", 7, c).unwrap();
        }
        state.resume("run1", 7).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Resume { clear: true });
        // The flag is spent: an untyped second pause resumes without clearing.
        state.resume("run1", 7).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Resume { clear: false });
    }

    #[test]
    fn a_submitted_command_is_the_host_talking_and_is_kept() {
        // Smoke 55-2 D2: the operator ran `echo lmnop` and pressed Enter. The
        // host printed it, usually before Resume was even pressed, and the next
        // step is entitled to match that. Clearing threw it away.
        let state = SkillRunState::default();
        let mut rx = state.register_host("run1", 7, "sess-7");
        state.session_id_for_input("run1", 7, b"echo lmnop").unwrap();
        state.session_id_for_input("run1", 7, b"\r").unwrap();
        state.resume("run1", 7).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Resume { clear: false });
    }

    #[test]
    fn typing_after_the_enter_puts_the_line_back_in_play() {
        // Ran a command, then started typing another and thought better of it.
        // The second line is still on the editor, so it still has to be
        // forgotten, and the first command's output goes with it. Nothing can
        // separate the two by then.
        let state = SkillRunState::default();
        let mut rx = state.register_host("run1", 7, "sess-7");
        state
            .session_id_for_input("run1", 7, b"echo lmnop\r")
            .unwrap();
        state.session_id_for_input("run1", 7, b"l").unwrap();
        state.resume("run1", 7).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Resume { clear: true });
    }

    #[test]
    fn cancel_returns_every_session_and_drops_the_run() {
        let state = SkillRunState::default();
        let _a = state.register_host("run1", 1, "sess-1");
        let _b = state.register_host("run1", 2, "sess-2");
        let mut sessions = state.cancel("run1");
        sessions.sort();
        assert_eq!(sessions, vec!["sess-1", "sess-2"]);
        assert!(!state.is_active("run1"));
    }

    #[test]
    fn cancel_closes_the_control_channels() {
        // The abort signal every parked engine relies on.
        let state = SkillRunState::default();
        let mut rx = state.register_host("run1", 1, "sess-1");
        state.cancel("run1");
        assert_eq!(rx.try_recv(), Err(tokio::sync::mpsc::error::TryRecvError::Disconnected));
    }

    #[test]
    fn run_is_dropped_once_its_last_host_finishes() {
        let state = SkillRunState::default();
        let _a = state.register_host("run1", 1, "sess-1");
        let _b = state.register_host("run1", 2, "sess-2");
        state.finish_host("run1", 1);
        assert!(state.is_active("run1"));
        state.finish_host("run1", 2);
        assert!(!state.is_active("run1"));
    }

    #[test]
    fn finishing_an_unknown_host_is_a_no_op() {
        let state = SkillRunState::default();
        state.finish_host("ghost", 1);
        assert!(!state.is_active("ghost"));
    }

    #[test]
    fn runs_are_isolated_from_each_other() {
        let state = SkillRunState::default();
        let _a = state.register_host("run1", 1, "sess-1");
        let mut b = state.register_host("run2", 1, "sess-2");
        state.cancel("run1");
        // run2's host is untouched by run1's cancel.
        state.send("run2", 1, Ctl::Abort).unwrap();
        assert_eq!(b.try_recv().unwrap(), Ctl::Abort);
    }

    #[test]
    fn detach_on_a_driven_host_signals_its_engine() {
        let state = SkillRunState::default();
        let mut rx = state.register_host("run1", 7, "sess-7");
        state.detach("run1", 7).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Detach);
    }

    #[test]
    fn a_lingering_host_keeps_the_run_alive_and_closes_on_close_run() {
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        state.linger_host("run1", 7);
        assert!(state.is_active("run1"));
        assert_eq!(state.close_run("run1"), vec!["sess-7".to_string()]);
        assert!(!state.is_active("run1"));
    }

    #[test]
    fn detach_on_a_lingering_host_hands_it_off_without_signalling() {
        // A finished host's shell lingers; detaching it just drops it from
        // tracking (no engine to signal) so Close run won't close it.
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        state.linger_host("run1", 7);
        state.detach("run1", 7).unwrap();
        assert!(!state.is_active("run1"));
        assert!(state.close_run("run1").is_empty());
    }

    #[test]
    fn adopt_host_keeps_the_session_out_of_close_run() {
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        state.adopt_host("run1", 7);
        // The terminal owns it now: the run is gone, nothing to close.
        assert!(!state.is_active("run1"));
        assert!(state.close_run("run1").is_empty());
    }

    #[test]
    fn cancel_closes_driven_and_lingering_but_not_adopted() {
        let state = SkillRunState::default();
        let _a = state.register_host("run1", 1, "sess-1"); // stays driven
        let _b = state.register_host("run1", 2, "sess-2");
        let _c = state.register_host("run1", 3, "sess-3");
        state.linger_host("run1", 2); // lingering
        state.adopt_host("run1", 3); // handed off to a terminal
        let mut sessions = state.cancel("run1");
        sessions.sort();
        assert_eq!(sessions, vec!["sess-1".to_string(), "sess-2".to_string()]);
    }

    #[test]
    fn detach_on_an_unknown_run_or_host_errors() {
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        assert!(state.detach("run1", 99).is_err());
        assert!(state.detach("nope", 7).is_err());
    }
}
