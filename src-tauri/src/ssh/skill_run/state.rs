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
    Resume,
    /// Treat the current step as satisfied and take its success branch.
    SkipStep,
    /// Stop this host after the current step.
    Abort,
}

struct HostEntry {
    session_id: String,
    ctl: mpsc::UnboundedSender<Ctl>,
}

#[derive(Default)]
struct RunEntry {
    hosts: HashMap<i64, HostEntry>,
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
                },
            );
        rx
    }

    /// Deregisters a finished host, and the run itself once its last host is
    /// done.
    pub fn finish_host(&self, run_id: &str, host_id: i64) {
        let mut map = self.0.lock().unwrap();
        if let Some(run) = map.get_mut(run_id) {
            run.hosts.remove(&host_id);
            if run.hosts.is_empty() {
                map.remove(run_id);
            }
        }
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
    pub fn session_id(&self, run_id: &str, host_id: i64) -> AppResult<String> {
        self.0
            .lock()
            .unwrap()
            .get(run_id)
            .and_then(|r| r.hosts.get(&host_id))
            .map(|h| h.session_id.clone())
            .ok_or_else(|| {
                AppError::State(format!("no active skill run {run_id} for host {host_id}"))
            })
    }

    /// Drops the whole run and returns the PTY session ids to close. Dropping
    /// the entry closes every control channel, which every engine, waiting or
    /// parked, reads as an abort.
    pub fn cancel(&self, run_id: &str) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .remove(run_id)
            .map(|run| run.hosts.into_values().map(|h| h.session_id).collect())
            .unwrap_or_default()
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
        state.send("run1", 7, Ctl::Resume).unwrap();
        assert_eq!(rx.try_recv().unwrap(), Ctl::Resume);
    }

    #[test]
    fn session_id_round_trips() {
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        assert_eq!(state.session_id("run1", 7).unwrap(), "sess-7");
    }

    #[test]
    fn send_to_an_unknown_run_or_host_errors() {
        let state = SkillRunState::default();
        let _rx = state.register_host("run1", 7, "sess-7");
        assert!(state.send("nope", 7, Ctl::Resume).is_err());
        assert!(state.send("run1", 99, Ctl::Resume).is_err());
        assert!(state.session_id("run1", 99).is_err());
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
}
