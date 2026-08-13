//! The record a skill run leaves behind, in Broadside rather than on the host.
//!
//! Until now a run's only durable trace was the host's own shell history: the
//! commands went out as the author wrote them, the shell recorded them, and an
//! operator wanting to know what a skill had done went looking on the machine it
//! had done it to. That works, and it is also the wrong place for it. The
//! history is per host, so a skill that ran against forty of them leaves forty
//! partial accounts; it holds the commands and not their exit codes; and it is
//! the operator's own scratchpad, which a tool has no business filling.
//!
//! So the record moves here, and the host's history becomes a choice (see
//! [`crate::commands::settings::skill_log_prefs`]). The file is JSONL with one
//! rotation generation, exactly like [`crate::errlog`], for the same reasons:
//! append-only is the only shape that survives a crash mid-run, and a structured
//! line is the only shape that can be rendered as either prose or JSON later.
//!
//! ## Why the storage is always JSON
//!
//! The operator picks how the log is *shown* and *exported*, prose or JSON, and
//! that choice is a display setting rather than a storage one. Storing prose and
//! rendering JSON is impossible; storing JSON and rendering prose costs a
//! formatter. Nothing is thrown away by writing the structured form, so the
//! structured form is what is written and the setting decides how it is read
//! back. The audit log already works this way (raw JSONL, a pretty-print
//! toggle), so this is the pattern the app has rather than a new one.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const FILE_NAME: &str = "skills.jsonl";
const ROTATED_NAME: &str = "skills.jsonl.1";
const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// The most of a command's output kept per step, at the Debug level.
///
/// A skill step is entitled to print a kernel build log, and the record of a run
/// is not the place to keep one. What matters when reading back why a step
/// branched the way it did is the beginning of what it said, so the tail is
/// dropped and the entry says so.
pub const MAX_OUTPUT_CHARS: usize = 2_000;

/// How much of a run is written down. The operator's choice, per
/// [`crate::commands::settings`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogDetail {
    /// One entry for the whole run on one host.
    #[default]
    Summary,
    /// One entry per step, saying what it was and how it went.
    Itemized,
    /// Exactly the step log the run panel showed, line for line. The panel is
    /// the account the operator already knows how to read, and this is that
    /// account kept rather than lost when the panel closes.
    Panel,
    /// Itemized, plus the line Broadside actually typed and what came back.
    Debug,
}

impl LogDetail {
    pub fn from_stored(value: Option<&str>) -> Self {
        match value {
            Some("itemized") => Self::Itemized,
            Some("panel") => Self::Panel,
            Some("debug") => Self::Debug,
            _ => Self::Summary,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Itemized => "itemized",
            Self::Panel => "panel",
            Self::Debug => "debug",
        }
    }

    /// Whether anything at all is written per step, as opposed to only the
    /// closing summary.
    pub fn writes_steps(self) -> bool {
        !matches!(self, Self::Summary)
    }

    /// Whether the line Broadside typed and the output it read are kept.
    pub fn writes_execution(self) -> bool {
        matches!(self, Self::Debug)
    }
}

/// Where a run's record goes. The remote half is not something written here: it
/// is the host's own shell history, and "remote" means Broadside leaves the
/// commands in it rather than putting them there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogWhere {
    /// Broadside's log, and the host's history kept clean.
    #[default]
    Skill,
    /// The host's history, and nothing written here. What build 57-2 did.
    Remote,
    /// Both.
    Both,
}

impl LogWhere {
    pub fn from_stored(value: Option<&str>) -> Self {
        match value {
            Some("remote") => Self::Remote,
            Some("both") => Self::Both,
            _ => Self::Skill,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skill => "skill",
            Self::Remote => "remote",
            Self::Both => "both",
        }
    }

    /// Whether a run writes entries to this log at all.
    pub fn writes_here(self) -> bool {
        matches!(self, Self::Skill | Self::Both)
    }

    /// Whether the host's shell is left recording the skill's commands.
    ///
    /// The engine reads this, and it is the only setting on this page that
    /// changes a byte sent to a host.
    pub fn keeps_remote_history(self) -> bool {
        matches!(self, Self::Remote | Self::Both)
    }
}

/// One step of a run, as the engine saw it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StepRecord {
    pub step_id: String,
    /// `run` | `expect` | `send` | `wait` | `log`.
    pub kind: String,
    /// 1-based position in the order the steps actually ran, which is not the
    /// order they are listed in: a skill branches.
    pub index: u32,
    /// The command the author wrote, on a `run` step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The line Broadside typed, when it is not the command verbatim. Debug
    /// only, and `None` whenever the two are the same, so an entry that has one
    /// is an entry where the difference is the point.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sent: Option<String>,
    /// What the host said back, trimmed to [`MAX_OUTPUT_CHARS`]. Debug only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u32>,
    /// `pass` | `fail` | `timeout` | `skipped` | `done`.
    pub condition: String,
    /// The step the run went to next.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub took_ms: u64,
    /// What the run panel showed for this step, kept verbatim for
    /// [`LogDetail::Panel`].
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub panel: Vec<String>,
}

/// A whole run against one host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub ts: String,
    pub run_id: String,
    pub host_id: i64,
    pub host_label: String,
    pub skill: String,
    /// How much of this was written, so a reader knows whether an absent step
    /// list means nothing happened or means Summary.
    pub detail: LogDetail,
    pub commands: u32,
    pub completed: u32,
    pub failed: u32,
    pub duration_ms: u64,
    /// `SUCCESS` | `FAILED` | `STOPPED` | `DETACHED`.
    pub result: String,
    /// The closing message, which is where a failure says what it was.
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<StepRecord>,
}

/// A run in progress, accumulating until the host reports its outcome.
struct OpenRun {
    started: Instant,
    skill: String,
    host_label: String,
    steps: Vec<StepRecord>,
    commands: u32,
    completed: u32,
    failed: u32,
    /// Lines the run panel showed since the last step was closed, waiting to be
    /// attached to it.
    panel: Vec<String>,
    index: u32,
}

pub struct SkillLogState {
    dir: PathBuf,
    max_bytes: u64,
    write_lock: Mutex<()>,
    /// `run_id:host_id -> the run so far`. A run that never reports (the app is
    /// killed mid-flight) leaves its entry here and is lost with the process,
    /// which is the right trade: a summary written before the outcome is known
    /// would be a lie about a run that may still have been going.
    open: Mutex<HashMap<String, OpenRun>>,
}

fn key(run_id: &str, host_id: i64) -> String {
    format!("{run_id}:{host_id}")
}

impl SkillLogState {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            max_bytes: DEFAULT_MAX_BYTES,
            write_lock: Mutex::new(()),
            open: Mutex::new(HashMap::new()),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    /// A host has started running a skill.
    pub fn begin(&self, run_id: &str, host_id: i64, host_label: &str, skill: &str) {
        let mut open = self.open.lock().expect("skill log map");
        open.insert(
            key(run_id, host_id),
            OpenRun {
                started: Instant::now(),
                skill: skill.to_string(),
                host_label: host_label.to_string(),
                steps: Vec::new(),
                commands: 0,
                completed: 0,
                failed: 0,
                panel: Vec::new(),
                index: 0,
            },
        );
    }

    /// One line as the run panel showed it, held against whichever step closes
    /// next. Cheap enough to take on every run: it is a `Vec` push behind a
    /// lock, and the alternative is a second copy of the panel's own formatting
    /// living in the frontend where it cannot be written to a file.
    pub fn panel_line(&self, run_id: &str, host_id: i64, line: String) {
        if let Some(run) = self.open.lock().expect("skill log map").get_mut(&key(run_id, host_id)) {
            // A pathological skill could loop for hours; the cap is per step and
            // generous, and it stops one runaway holding the process's memory.
            if run.panel.len() < 500 {
                run.panel.push(line);
            }
        }
    }

    /// One step, finished.
    pub fn step(&self, run_id: &str, host_id: i64, mut record: StepRecord) {
        let mut open = self.open.lock().expect("skill log map");
        let Some(run) = open.get_mut(&key(run_id, host_id)) else {
            return;
        };
        run.index += 1;
        record.index = run.index;
        if record.command.is_some() {
            run.commands += 1;
        }
        match record.condition.as_str() {
            "fail" | "timeout" => run.failed += 1,
            _ => run.completed += 1,
        }
        record.panel = std::mem::take(&mut run.panel);
        run.steps.push(record);
    }

    /// The host is done. Writes the entry, if this run is being recorded, and
    /// forgets it either way.
    ///
    /// `detail` is read here rather than at `begin` so a change made in Settings
    /// mid-run takes effect on the run in front of the operator, which is what
    /// "takes effect immediately" has to mean for a setting on a page they are
    /// looking at while a skill runs.
    pub fn finish(
        &self,
        run_id: &str,
        host_id: i64,
        ok: bool,
        message: &str,
        detail: LogDetail,
        write: bool,
    ) {
        let Some(run) = self.open.lock().expect("skill log map").remove(&key(run_id, host_id))
        else {
            return;
        };
        if !write {
            return;
        }
        let trailing = run.panel;
        let mut steps = if detail.writes_steps() {
            run.steps
        } else {
            Vec::new()
        };
        // Itemized asked for one line per step, so the panel's own account of
        // the same step is not part of what it asked for. Kept only where it is
        // the point (Panel) or where everything is (Debug), so the file stays
        // the size the level implies.
        if matches!(detail, LogDetail::Panel | LogDetail::Debug) {
            // Whatever the panel said after the last step closed, which is the
            // line saying how the run ended: the engine reports a step the
            // moment it is over and only then announces the failure that ended
            // it, so that line arrives with no step left to attach it to.
            // Dropped, it would be the one line of the panel's account this
            // level does not have, and the one most worth reading.
            if let Some(last) = steps.last_mut() {
                last.panel.extend(trailing);
            }
        } else {
            for step in &mut steps {
                step.panel.clear();
            }
        }
        // Same rule, same reason, for the two fields that are Debug's answer and
        // nobody else's. A level that says "one line per step" has no business
        // costing two thousand characters a step on disk, and no level can gain
        // detail it was not written with, so keeping them would only make the
        // file bigger and rotate it sooner.
        if !detail.writes_execution() {
            for step in &mut steps {
                step.sent = None;
                step.output = None;
            }
        }
        let record = RunRecord {
            ts: Utc::now().to_rfc3339(),
            run_id: run_id.to_string(),
            host_id,
            host_label: run.host_label,
            skill: run.skill,
            detail,
            commands: run.commands,
            completed: run.completed,
            failed: run.failed,
            duration_ms: run.started.elapsed().as_millis() as u64,
            result: if ok { "SUCCESS".into() } else { "FAILED".into() },
            message: message.to_string(),
            steps,
        };
        let _ = self.append(&record);
    }

    /// Appends one run. Write errors are returned but callers ignore them:
    /// keeping the record must never break the run it is a record of.
    pub fn append(&self, record: &RunRecord) -> AppResult<()> {
        let mut line = serde_json::to_string(record)?;
        line.push('\n');

        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| AppError::State("skill log lock poisoned".into()))?;
        fs::create_dir_all(&self.dir)?;
        let path = self.path();
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() + line.len() as u64 > self.max_bytes {
                let _ = fs::remove_file(self.dir.join(ROTATED_NAME));
                fs::rename(&path, self.dir.join(ROTATED_NAME))?;
            }
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Last `max_lines` lines of the current file.
    pub fn tail(&self, max_lines: usize) -> AppResult<Vec<String>> {
        let path = self.path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let content = fs::read_to_string(&path)?;
        let lines: Vec<&str> = content.lines().collect();
        let start = lines.len().saturating_sub(max_lines);
        Ok(lines[start..].iter().map(|s| s.to_string()).collect())
    }

    /// Removes the current and rotated files. Returns how many were deleted.
    pub fn clear(&self) -> AppResult<usize> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| AppError::State("skill log lock poisoned".into()))?;
        let mut removed = 0;
        for name in [FILE_NAME, ROTATED_NAME] {
            if fs::remove_file(self.dir.join(name)).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }
}

/// Cuts a command's output down to what is worth keeping, saying so when it
/// cuts. Char-wise, not byte-wise: a boundary in the middle of a UTF-8 sequence
/// would put a replacement character in the record.
pub fn trimmed_output(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.chars().count() <= MAX_OUTPUT_CHARS {
        return trimmed.to_string();
    }
    let kept: String = trimmed.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{kept}\n... trimmed at {MAX_OUTPUT_CHARS} characters ...")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn state() -> (TempDir, SkillLogState) {
        let dir = TempDir::new().unwrap();
        let log = SkillLogState::new(dir.path().into());
        (dir, log)
    }

    fn run_step(id: &str, condition: &str) -> StepRecord {
        StepRecord {
            step_id: id.into(),
            kind: "run".into(),
            command: Some(format!("do {id}")),
            condition: condition.into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_summary_counts_the_steps_without_keeping_them() {
        let (_dir, log) = state();
        log.begin("run1", 7, "web-01", "Configure Web Server");
        log.step("run1", 7, run_step("a", "pass"));
        log.step("run1", 7, run_step("b", "fail"));
        log.finish("run1", 7, true, "finished", LogDetail::Summary, true);

        let lines = log.tail(10).unwrap();
        assert_eq!(lines.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(v["skill"], "Configure Web Server");
        assert_eq!(v["host_label"], "web-01");
        assert_eq!(v["commands"], 2);
        assert_eq!(v["completed"], 1);
        assert_eq!(v["failed"], 1);
        assert_eq!(v["result"], "SUCCESS");
        // The counting happened, the steps did not survive it.
        assert!(v.get("steps").is_none(), "summary kept step detail: {v}");
    }

    #[test]
    fn itemized_keeps_the_steps_in_the_order_they_ran() {
        let (_dir, log) = state();
        log.begin("run1", 7, "web-01", "Skill");
        log.step("run1", 7, run_step("first", "pass"));
        log.step("run1", 7, run_step("second", "pass"));
        log.finish("run1", 7, true, "finished", LogDetail::Itemized, true);

        let v: serde_json::Value = serde_json::from_str(&log.tail(1).unwrap()[0]).unwrap();
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        // Indexes are positions in the run, not in the skill: a branch means the
        // two are not the same list.
        assert_eq!(steps[0]["index"], 1);
        assert_eq!(steps[1]["index"], 2);
        assert_eq!(steps[1]["step_id"], "second");
    }

    #[test]
    fn itemized_does_not_carry_the_panels_account_of_the_same_step() {
        // One line per step is what was asked for; the panel's version of it is
        // a different level's answer and would only make the file bigger.
        let (_dir, log) = state();
        log.begin("run1", 7, "web-01", "Skill");
        log.panel_line("run1", 7, "    step first       run: do first".into());
        log.step("run1", 7, run_step("first", "pass"));
        log.finish("run1", 7, true, "finished", LogDetail::Itemized, true);

        let v: serde_json::Value = serde_json::from_str(&log.tail(1).unwrap()[0]).unwrap();
        assert!(
            v["steps"][0].get("panel").is_none(),
            "itemized kept the panel lines: {v}"
        );
    }

    #[test]
    fn only_debug_keeps_the_line_typed_and_the_output_read() {
        let (_dir, log) = state();
        let heavy = |id: &str| StepRecord {
            sent: Some(" cmd; printf '__bsdone_%s__\\n' \"$?\"".into()),
            output: Some("a great deal of output".into()),
            ..run_step(id, "pass")
        };
        for (detail, kept) in [
            (LogDetail::Itemized, false),
            (LogDetail::Panel, false),
            (LogDetail::Debug, true),
        ] {
            log.begin("run1", 7, "web-01", "Skill");
            log.step("run1", 7, heavy("a"));
            log.finish("run1", 7, true, "finished", detail, true);
            let lines = log.tail(10).unwrap();
            let v: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
            let step = &v["steps"][0];
            assert_eq!(
                step.get("output").is_some(),
                kept,
                "{detail:?} kept the wrong thing: {v}"
            );
            assert_eq!(step.get("sent").is_some(), kept, "{detail:?}: {v}");
        }
    }

    #[test]
    fn panel_lines_attach_to_the_step_that_closes_after_them() {
        let (_dir, log) = state();
        log.begin("run1", 7, "web-01", "Skill");
        log.panel_line("run1", 7, "    step first       run: do first".into());
        log.panel_line("run1", 7, " matched first       exit 0".into());
        log.step("run1", 7, run_step("first", "pass"));
        log.panel_line("run1", 7, "    step second      run: do second".into());
        log.step("run1", 7, run_step("second", "pass"));
        log.finish("run1", 7, true, "finished", LogDetail::Panel, true);

        let v: serde_json::Value = serde_json::from_str(&log.tail(1).unwrap()[0]).unwrap();
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps[0]["panel"].as_array().unwrap().len(), 2);
        assert_eq!(steps[1]["panel"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_last_thing_the_panel_said_is_not_lost() {
        // The order the engine reports in: the step that failed is written down
        // first, and only then does the panel say why the run stopped. So the
        // most important line of the account arrives after the last step has
        // already taken its own lines away.
        let (_dir, log) = state();
        log.begin("run1", 7, "web-01", "Skill");
        log.panel_line("run1", 7, "step run: test -f /etc/nginx/nginx.conf".into());
        log.step("run1", 7, run_step("nginx", "fail"));
        log.panel_line("run1", 7, "failed this host is not a web server".into());
        log.finish("run1", 7, false, "stopped", LogDetail::Panel, true);

        let v: serde_json::Value = serde_json::from_str(&log.tail(1).unwrap()[0]).unwrap();
        let panel = v["steps"][0]["panel"].as_array().unwrap();
        assert_eq!(panel.len(), 2, "the closing line was dropped: {v}");
        assert_eq!(panel[1], "failed this host is not a web server");
    }

    #[test]
    fn a_run_nobody_is_recording_writes_nothing_but_is_still_forgotten() {
        let (_dir, log) = state();
        log.begin("run1", 7, "web-01", "Skill");
        log.step("run1", 7, run_step("a", "pass"));
        log.finish("run1", 7, true, "finished", LogDetail::Summary, false);
        assert!(log.tail(10).unwrap().is_empty());
        // Forgotten: a second finish for the same host has nothing to write.
        log.finish("run1", 7, true, "finished", LogDetail::Summary, true);
        assert!(log.tail(10).unwrap().is_empty());
    }

    #[test]
    fn hosts_of_one_run_are_kept_apart() {
        let (_dir, log) = state();
        log.begin("run1", 1, "web-01", "Skill");
        log.begin("run1", 2, "web-02", "Skill");
        log.step("run1", 1, run_step("a", "pass"));
        log.step("run1", 2, run_step("a", "fail"));
        log.step("run1", 2, run_step("b", "fail"));
        log.finish("run1", 1, true, "finished", LogDetail::Summary, true);
        log.finish("run1", 2, false, "step b failed", LogDetail::Summary, true);

        let lines = log.tail(10).unwrap();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        let second: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(first["host_label"], "web-01");
        assert_eq!(first["failed"], 0);
        assert_eq!(second["host_label"], "web-02");
        assert_eq!(second["failed"], 2);
        assert_eq!(second["result"], "FAILED");
    }

    #[test]
    fn steps_for_a_run_that_never_began_are_dropped_rather_than_panicking() {
        // The engine is not the only thing that can end a run: an emergency stop
        // drops it from under a host that is mid-step.
        let (_dir, log) = state();
        log.step("ghost", 1, run_step("a", "pass"));
        log.panel_line("ghost", 1, "anything".into());
        log.finish("ghost", 1, true, "", LogDetail::Summary, true);
        assert!(log.tail(10).unwrap().is_empty());
    }

    #[test]
    fn clear_removes_the_file() {
        let (_dir, log) = state();
        log.begin("run1", 7, "web-01", "Skill");
        log.finish("run1", 7, true, "finished", LogDetail::Summary, true);
        assert_eq!(log.tail(10).unwrap().len(), 1);
        assert_eq!(log.clear().unwrap(), 1);
        assert!(log.tail(10).unwrap().is_empty());
    }

    #[test]
    fn output_is_trimmed_on_a_character_boundary() {
        let short = trimmed_output("  hello  ");
        assert_eq!(short, "hello");
        // Multi-byte, so a byte-wise cut would land mid-sequence.
        let long: String = "é".repeat(MAX_OUTPUT_CHARS + 50);
        let out = trimmed_output(&long);
        assert!(out.contains("trimmed at"), "{out}");
        assert_eq!(out.chars().filter(|c| *c == 'é').count(), MAX_OUTPUT_CHARS);
    }

    #[test]
    fn the_stored_forms_round_trip() {
        for w in [LogWhere::Skill, LogWhere::Remote, LogWhere::Both] {
            assert_eq!(LogWhere::from_stored(Some(w.as_str())), w);
        }
        for d in [
            LogDetail::Summary,
            LogDetail::Itemized,
            LogDetail::Panel,
            LogDetail::Debug,
        ] {
            assert_eq!(LogDetail::from_stored(Some(d.as_str())), d);
        }
        // Anything unreadable is the recommended default, never a guess.
        assert_eq!(LogWhere::from_stored(None), LogWhere::Skill);
        assert_eq!(LogWhere::from_stored(Some("nonsense")), LogWhere::Skill);
        assert_eq!(LogDetail::from_stored(Some("nonsense")), LogDetail::Summary);
    }

    #[test]
    fn only_the_settings_that_say_so_leave_the_host_recording() {
        assert!(!LogWhere::Skill.keeps_remote_history());
        assert!(LogWhere::Remote.keeps_remote_history());
        assert!(LogWhere::Both.keeps_remote_history());
        assert!(LogWhere::Skill.writes_here());
        assert!(!LogWhere::Remote.writes_here());
        assert!(LogWhere::Both.writes_here());
    }
}
