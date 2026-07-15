//! Skill CRUD, pre-flight and run control.
//!
//! The run itself lives in [`skill_run`](crate::ssh::skill_run); this module is
//! the boundary: it resolves hosts and credentials, enforces the destructive
//! guard **server-side** (D-014), audits the dispatch, and hands each host to
//! an engine over its own live PTY.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Semaphore;

use super::settings::{load_cached_probe, load_max_sessions, load_user_rules};
use super::ssh::{auth_for_host, with_db};
use crate::audit::{AuditEvent, AuditState};
use crate::credentials::CredentialState;
use crate::db::hosts as host_repo;
use crate::db::skills as skill_repo;
use crate::db::{host_keys, DbState};
use crate::error::{AppError, AppResult};
use crate::guard::{self, GuardHit};
use crate::ssh::pty::PtyState;
use crate::ssh::skill_run::{
    self, state::Ctl, state::SkillRunState, Engine, HostMeta, SkillDone, SkillEvents,
};

#[tauri::command]
pub fn list_skills(state: State<'_, DbState>) -> AppResult<Vec<skill_repo::Skill>> {
    with_db(&state, skill_repo::list)
}

#[tauri::command]
pub fn get_skill(id: i64, state: State<'_, DbState>) -> AppResult<skill_repo::Skill> {
    with_db(&state, |conn| skill_repo::get(conn, id))
}

#[tauri::command]
pub fn create_skill(
    input: skill_repo::SkillInput,
    state: State<'_, DbState>,
) -> AppResult<skill_repo::Skill> {
    validate_config(&input)?;
    with_db(&state, |conn| skill_repo::create(conn, &input))
}

#[tauri::command]
pub fn update_skill(
    id: i64,
    input: skill_repo::SkillInput,
    state: State<'_, DbState>,
) -> AppResult<skill_repo::Skill> {
    validate_config(&input)?;
    with_db(&state, |conn| skill_repo::update(conn, id, &input))
}

#[tauri::command]
pub fn delete_skill(id: i64, state: State<'_, DbState>) -> AppResult<usize> {
    with_db(&state, |conn| skill_repo::delete(conn, id))
}

/// Rejects a broken step graph at save time, so the operator hears about a
/// dangling branch or an uncompilable pattern then, not halfway through an
/// upgrade on twelve hosts.
fn validate_config(input: &skill_repo::SkillInput) -> AppResult<()> {
    if input.kind != skill_repo::KIND_SEQUENCE {
        return Ok(());
    }
    let cfg = skill_run::parse_sequence(&input.config_json)?;
    skill_run::config::validate_sequence(&cfg)
}

/// What the operator should know before a run starts: which steps trip the
/// destructive guard, and which hosts will fail their sudo steps for want of a
/// stored password.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPreflight {
    pub matched_rules: Vec<GuardHit>,
    pub uses_sudo: bool,
    pub hosts_missing_sudo: Vec<String>,
}

/// One live terminal the run is about to drive. Returned the moment the run is
/// dispatched so the panes can mount and the operator can watch from the first
/// byte.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPane {
    pub host_id: i64,
    pub label: String,
    pub color: String,
    pub session_id: String,
}

fn session_id_for(run_id: &str, host_id: i64) -> String {
    format!("skill-{run_id}-{host_id}")
}

/// Loads a skill and applies the user's parameters, ready to run.
fn prepared(
    state: &State<'_, DbState>,
    skill_id: i64,
    params: &HashMap<String, String>,
) -> AppResult<(skill_repo::Skill, skill_run::config::SequenceConfig)> {
    let skill = with_db(state, |conn| skill_repo::get(conn, skill_id))?;
    if skill.kind != skill_repo::KIND_SEQUENCE {
        // Phase 2 lands the AI engine on this same substrate.
        return Err(AppError::InvalidInput(
            "AI skills aren't runnable yet: this build ships sequence skills only".into(),
        ));
    }
    let cfg = skill_run::parse_sequence(&skill.config_json)?;
    // Substitution happens here, backend-side: everything downstream (the
    // guard, the audit log, the host) sees the real command text.
    let prepared = skill_run::prepare(&cfg, params)?;
    Ok((skill, prepared))
}

/// The frontend's pre-run check, driving the CONFIRM dialog and the warnings.
/// `run_skill` re-runs the same guard check; this one is UX, that one is the
/// gate.
#[tauri::command]
pub fn skill_preflight(
    skill_id: i64,
    host_ids: Vec<i64>,
    params: HashMap<String, String>,
    state: State<'_, DbState>,
) -> AppResult<SkillPreflight> {
    let (_, cfg) = prepared(&state, skill_id, &params)?;
    let user_rules = with_db(&state, load_user_rules)?;
    let mut matched_rules: Vec<GuardHit> = Vec::new();
    for text in cfg.dispatched_text() {
        for hit in guard::check_with_user(&text, &user_rules) {
            if !matched_rules.iter().any(|h| h.rule_id == hit.rule_id) {
                matched_rules.push(hit);
            }
        }
    }
    let uses_sudo = skill_run::needs_sudo_password(&cfg);
    let mut hosts_missing_sudo = Vec::new();
    if uses_sudo {
        for host_id in &host_ids {
            let host = with_db(&state, |conn| host_repo::get(conn, *host_id))?;
            // root has no sudo prompt to answer, so it needs nothing stored.
            if !host.has_sudo_password && !host.username.eq_ignore_ascii_case("root") {
                hosts_missing_sudo.push(host.label);
            }
        }
    }
    Ok(SkillPreflight {
        matched_rules,
        uses_sudo,
        hosts_missing_sudo,
    })
}

/// Dispatches a skill against every selected host.
///
/// Returns as soon as the runs are launched, handing back the panes to mount.
/// a skill run is watched, not awaited, and can last as long as an `apt
/// upgrade`. Everything after this point arrives as `skill:progress` /
/// `skill:paused` / `skill:done`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_skill(
    run_id: String,
    host_ids: Vec<i64>,
    skill_id: i64,
    params: HashMap<String, String>,
    confirmed: Option<bool>,
    cols: u32,
    rows: u32,
    app: AppHandle,
    state: State<'_, DbState>,
    cred_state: State<'_, CredentialState>,
    audit: State<'_, AuditState>,
    run_state: State<'_, SkillRunState>,
) -> AppResult<Vec<SkillPane>> {
    if host_ids.is_empty() {
        return Err(AppError::InvalidInput("no hosts selected".into()));
    }
    if run_state.is_active(&run_id) {
        return Err(AppError::InvalidInput("that run is already going".into()));
    }
    let (skill, cfg) = prepared(&state, skill_id, &params)?;

    // Defense in depth (D-014): the frontend modal is the UX, this is the gate.
    // A destructive step without the confirmed flag is refused whatever the IPC
    // caller claims, and it is checked against the *substituted* text, so a
    // parameter can't smuggle one past.
    let user_rules = with_db(&state, load_user_rules)?;
    let mut hits: Vec<GuardHit> = Vec::new();
    for text in cfg.dispatched_text() {
        for hit in guard::check_with_user(&text, &user_rules) {
            if !hits.iter().any(|h| h.rule_id == hit.rule_id) {
                hits.push(hit);
            }
        }
    }
    if !hits.is_empty() && confirmed != Some(true) {
        let rules: Vec<&str> = hits.iter().map(|h| h.rule_id.as_str()).collect();
        return Err(AppError::DestructiveBlocked(rules.join(", ")));
    }

    // Gather every per-host input synchronously, so no db or credential lock is
    // held across an await.
    struct Job {
        host: host_repo::Host,
        fingerprints: Vec<String>,
        auth: Option<crate::ssh::AuthMethod>,
        sudo_password: Option<String>,
    }
    let sudo_autofill = with_db(&state, |conn| {
        crate::db::settings::get_bool(conn, crate::commands::settings::KEY_SUDO_AUTOFILL, true)
    })?;
    let mut jobs = Vec::with_capacity(host_ids.len());
    for host_id in &host_ids {
        let (host, keys) = with_db(&state, |conn| {
            let host = host_repo::get(conn, *host_id)?;
            let keys = host_keys::list_for_endpoint(conn, &host.hostname, host.port)?;
            Ok((host, keys))
        })?;
        // Same gate as a terminal tab (D-065): the injector answers the prompt
        // the engine's `sudo` step provokes, exactly as it would for a human.
        let sudo_password = if sudo_autofill
            && host.has_sudo_password
            && !host.username.eq_ignore_ascii_case("root")
        {
            cred_state.get_sudo_password(host.id).ok().flatten()
        } else {
            None
        };
        jobs.push(Job {
            fingerprints: keys.iter().map(|k| k.fingerprint_sha256.clone()).collect(),
            auth: auth_for_host(&host, &cred_state)?,
            sudo_password,
            host,
        });
    }

    // Audit the dispatch (D-011), enriched with guard info (D-014). Never
    // blocks the run.
    let _ = audit.append(&AuditEvent::SkillRun {
        skill_name: skill.name.clone(),
        skill_kind: skill.kind.clone(),
        host_labels: jobs.iter().map(|j| j.host.label.clone()).collect(),
        matched_rules: hits.iter().map(|h| h.rule_id.clone()).collect(),
        confirmed: confirmed == Some(true),
    });

    let max_sessions = with_db(&state, |conn| {
        Ok(match load_max_sessions(conn)? {
            Some(n) => n,
            None => load_cached_probe(conn)?
                .map(|p| p.suggested_max_sessions)
                .unwrap_or(512),
        })
    })?
    .max(1);
    let semaphore = Arc::new(Semaphore::new(max_sessions));

    let panes: Vec<SkillPane> = jobs
        .iter()
        .map(|j| SkillPane {
            host_id: j.host.id,
            label: j.host.label.clone(),
            color: j.host.color.clone(),
            session_id: session_id_for(&run_id, j.host.id),
        })
        .collect();

    let cfg = Arc::new(cfg);
    let events = Arc::new(app.clone());
    for job in jobs {
        let session_id = session_id_for(&run_id, job.host.id);
        let ctl_rx = run_state.register_host(&run_id, job.host.id, &session_id);
        let meta = HostMeta {
            run_id: run_id.clone(),
            host_id: job.host.id,
            label: job.host.label.clone(),
            session_id: session_id.clone(),
        };
        let app = app.clone();
        let cfg = cfg.clone();
        let events = events.clone();
        let semaphore = semaphore.clone();
        let run_state = run_state.inner().clone();
        let pty_state = app.state::<PtyState>().inner().clone();
        let run_id_for_task = run_id.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = semaphore.acquire().await;
            let host_id = job.host.id;
            match job.auth {
                None => {
                    events.done(SkillDone {
                        run_id: run_id_for_task.clone(),
                        host_id,
                        label: meta.label.clone(),
                        session_id: session_id.clone(),
                        ok: false,
                        message: "no credentials stored".into(),
                    });
                }
                Some(auth) => {
                    // The tap forwards every byte to the live pane *and* to the
                    // engine: pty.rs is untouched, and what the engine matches
                    // is what the operator is watching.
                    let (link, tap) = skill_run::tap(app.clone(), session_id.clone());
                    let opened = crate::ssh::pty::open(
                        tap,
                        &pty_state,
                        session_id.clone(),
                        &job.host.label,
                        &job.host.hostname,
                        job.host.port,
                        &job.host.username,
                        job.fingerprints,
                        auth,
                        job.sudo_password,
                        cols.clamp(2, 1000),
                        rows.clamp(2, 1000),
                    )
                    .await;
                    match opened {
                        Ok(crate::ssh::pty::PtyOpenResult::Opened) => {
                            let engine = Engine::new(link, ctl_rx, events.clone(), meta.clone());
                            skill_run::run_host(engine, &cfg, events.clone()).await;
                        }
                        Ok(other) => events.done(SkillDone {
                            run_id: run_id_for_task.clone(),
                            host_id,
                            label: meta.label.clone(),
                            session_id: session_id.clone(),
                            ok: false,
                            message: open_failure_message(&other),
                        }),
                        Err(e) => events.done(SkillDone {
                            run_id: run_id_for_task.clone(),
                            host_id,
                            label: meta.label.clone(),
                            session_id: session_id.clone(),
                            ok: false,
                            message: format!("could not open a shell: {e}"),
                        }),
                    }
                    // The run owns this session start to finish; leaving it open
                    // would strand a shell (and a root shell at that).
                    let _ = pty_state.close(&session_id);
                }
            }
            run_state.finish_host(&run_id_for_task, host_id);
        });
    }
    Ok(panes)
}

fn open_failure_message(result: &crate::ssh::pty::PtyOpenResult) -> String {
    use crate::ssh::pty::PtyOpenResult as R;
    match result {
        R::AuthFailed { message } => format!("authentication failed: {message}"),
        R::Unreachable { message } => format!("unreachable: {message}"),
        R::KeyMismatch { .. } => "host key mismatch: connection refused".into(),
        R::UnknownKey { .. } => {
            "this host's key isn't trusted yet. Open a terminal to it once to review the key".into()
        }
        R::NoCredentials => "no credentials stored".into(),
        R::Opened => "opened".into(),
    }
}

/// Emergency stop: kills the sequence on **every** host at once by closing each
/// PTY. Irreversible and abrupt by design: it can leave a host mid-`apt`. The
/// graceful controls are per-host (`skill_abort`).
#[tauri::command]
pub fn skill_cancel(
    run_id: String,
    run_state: State<'_, SkillRunState>,
    pty_state: State<'_, PtyState>,
) -> AppResult<()> {
    // Dropping the run's entry closes every control channel, which each engine
    // (waiting or parked) reads as an abort.
    for session_id in run_state.cancel(&run_id) {
        let _ = pty_state.close(&session_id);
    }
    Ok(())
}

/// Wait for the current step's pattern again, with a fresh timeout. Does not
/// re-send a command that is still running.
#[tauri::command]
pub fn skill_resume(
    run_id: String,
    host_id: i64,
    run_state: State<'_, SkillRunState>,
) -> AppResult<()> {
    run_state.send(&run_id, host_id, Ctl::Resume)
}

/// Treat the paused step as satisfied and take its success branch.
#[tauri::command]
pub fn skill_skip_step(
    run_id: String,
    host_id: i64,
    run_state: State<'_, SkillRunState>,
) -> AppResult<()> {
    run_state.send(&run_id, host_id, Ctl::SkipStep)
}

/// Stop one host gracefully, leaving the others running.
#[tauri::command]
pub fn skill_abort(
    run_id: String,
    host_id: i64,
    run_state: State<'_, SkillRunState>,
) -> AppResult<()> {
    run_state.send(&run_id, host_id, Ctl::Abort)
}

/// Manual takeover: routes the operator's keystrokes to the host's PTY through
/// the same `SessionCmd::Write` channel the engine uses. Safe against races
/// because a paused engine sends nothing until the operator resumes it.
#[tauri::command]
pub fn skill_send_input(
    run_id: String,
    host_id: i64,
    data: String,
    run_state: State<'_, SkillRunState>,
    pty_state: State<'_, PtyState>,
) -> AppResult<()> {
    let session_id = run_state.session_id(&run_id, host_id)?;
    pty_state.write(&session_id, data.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_are_unique_per_host_and_run() {
        assert_eq!(session_id_for("run1", 7), "skill-run1-7");
        assert_ne!(session_id_for("run1", 7), session_id_for("run1", 8));
        assert_ne!(session_id_for("run1", 7), session_id_for("run2", 7));
    }

    #[test]
    fn a_broken_graph_is_refused_at_save_time() {
        let input = skill_repo::SkillInput {
            name: "broken".into(),
            description: String::new(),
            icon: None,
            kind: skill_repo::KIND_SEQUENCE.into(),
            config_json: r#"{"startStepId":"a","steps":[
                {"kind":"send","id":"a","input":"x","next":"ghost"}]}"#
                .into(),
        };
        let err = validate_config(&input).unwrap_err().to_string();
        assert!(err.contains("ghost"), "got: {err}");
    }

    #[test]
    fn a_well_formed_graph_saves() {
        let input = skill_repo::SkillInput {
            name: "fine".into(),
            description: String::new(),
            icon: None,
            kind: skill_repo::KIND_SEQUENCE.into(),
            config_json: r#"{"startStepId":"a","steps":[
                {"kind":"send","id":"a","input":"x","next":"stop"}]}"#
                .into(),
        };
        assert!(validate_config(&input).is_ok());
    }
}
