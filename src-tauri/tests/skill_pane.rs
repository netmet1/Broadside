//! A whole skill, driven against a real bash login shell in docker, checked
//! against what the operator would have been looking at.
//!
//!     cargo test --test skill_pane -- --ignored --nocapture
//!
//! The unit tests in `skill_run::tests` drive the engine against a fake host
//! that answers questions but does not draw, and `skill_run::pane_tests` puts a
//! modelled shell behind a real curtain in front of a modelled terminal. This is
//! the join: a real shell, a real login, real sudo, and every byte that gets
//! past the curtain rendered through a terminal, so the assertion can be the one
//! that actually matters, which is that none of Broadside's own plumbing is on
//! the glass.
//!
//! Ignored by default, like the other docker suites (D-035).

mod skills_host;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use broadside_lib::ssh::pty::{
    open, PtyBlock, PtyClosed, PtyData, PtyEvents, PtyOpenResult, PtyState, SudoInjected,
};
use broadside_lib::ssh::skill_run::config::{
    LogLevel, MatchBranch, SeqStep, SequenceConfig, TimeoutAction, STOP,
};
use broadside_lib::ssh::skill_run::curtain::Curtain;
use broadside_lib::ssh::skill_run::state::Ctl;
use broadside_lib::ssh::skill_run::{
    prepare, run_host, Engine, HostMeta, PtyLink, SkillDone, SkillEvents, SkillPaused,
    SkillProgress, TapMsg,
};
use broadside_lib::ssh::{probe, AuthMethod, ProbeResult, ShellIntegrationPref};
use skills_host::{SkillsHost, PASSWORD, USER};
use tokio::sync::mpsc;

const ROWS: u32 = 40;

// ---------------------------------------------------------------------------
// A terminal, so the test can read the pane instead of the wire
// ---------------------------------------------------------------------------

/// Enough of a terminal to answer "what is on the screen": a grid, a cursor, and
/// the sequences a shell actually uses to move and erase. Everything else (
/// colour, keypad modes, titles) is consumed and dropped, which is the right
/// model for this question: those change how text looks, not whether it is
/// there.
struct Term {
    rows: Vec<Vec<char>>,
    row: usize,
    col: usize,
    cols: usize,
    saved: (usize, usize),
}

impl Term {
    fn new(cols: usize) -> Self {
        Term {
            rows: vec![Vec::new()],
            row: 0,
            col: 0,
            cols,
            saved: (0, 0),
        }
    }

    fn feed(&mut self, text: &str) {
        let mut it = text.chars().peekable();
        while let Some(c) = it.next() {
            match c {
                '\u{1b}' => match it.next() {
                    Some('[') => {
                        let mut buf = String::new();
                        let action = loop {
                            match it.next() {
                                Some(c) if ('\u{40}'..='\u{7e}').contains(&c) => break c,
                                Some(c) => buf.push(c),
                                None => return,
                            }
                        };
                        self.csi(&buf, action);
                    }
                    // OSC: to BEL, or to the ST form (ESC \).
                    Some(']') => loop {
                        match it.next() {
                            Some('\u{7}') | None => break,
                            Some('\u{1b}') => {
                                it.next();
                                break;
                            }
                            Some(_) => {}
                        }
                    },
                    Some('7') => self.saved = (self.row, self.col),
                    Some('8') => {
                        self.row = self.saved.0;
                        self.col = self.saved.1;
                        self.grow();
                    }
                    // Charset selection: one more byte belongs to it.
                    Some('(') | Some(')') | Some('*') | Some('+') => {
                        it.next();
                    }
                    _ => {}
                },
                '\n' => {
                    self.row += 1;
                    self.col = 0;
                    self.grow();
                }
                '\r' => self.col = 0,
                '\u{8}' => self.col = self.col.saturating_sub(1),
                '\t' => {
                    let next = (self.col / 8 + 1) * 8;
                    while self.col < next.min(self.cols) {
                        self.put(' ');
                    }
                }
                c if (c as u32) >= 0x20 => self.put(c),
                _ => {}
            }
        }
    }

    fn csi(&mut self, params: &str, action: char) {
        // A private sequence (?1049h, ?2004h) changes a mode, not the text.
        if params.starts_with('?') {
            return;
        }
        let nums: Vec<usize> = params
            .split(';')
            .map(|p| p.parse::<usize>().unwrap_or(0))
            .collect();
        let n = nums.first().copied().unwrap_or(0);
        match action {
            'A' => self.row = self.row.saturating_sub(n.max(1)),
            'B' => {
                self.row += n.max(1);
                self.grow();
            }
            'C' => self.col = (self.col + n.max(1)).min(self.cols),
            'D' => self.col = self.col.saturating_sub(n.max(1)),
            'G' => self.col = n.saturating_sub(1),
            'H' | 'f' => {
                self.row = n.saturating_sub(1);
                self.col = nums.get(1).copied().unwrap_or(1).saturating_sub(1);
                self.grow();
            }
            'J' => match n {
                1 => {
                    for r in 0..self.row {
                        self.rows[r].clear();
                    }
                    let col = self.col;
                    blank_to(&mut self.rows[self.row], col);
                }
                2 | 3 => {
                    for r in self.rows.iter_mut() {
                        r.clear();
                    }
                }
                _ => {
                    self.rows[self.row].truncate(self.col);
                    self.rows.truncate(self.row + 1);
                }
            },
            'K' => match n {
                1 => {
                    let col = self.col;
                    blank_to(&mut self.rows[self.row], col);
                }
                2 => self.rows[self.row].clear(),
                _ => {
                    let col = self.col;
                    self.rows[self.row].truncate(col);
                }
            },
            'P' => {
                let row = &mut self.rows[self.row];
                for _ in 0..n.max(1) {
                    if self.col < row.len() {
                        row.remove(self.col);
                    }
                }
            }
            'X' => {
                let col = self.col;
                let row = &mut self.rows[self.row];
                for i in col..(col + n.max(1)).min(row.len()) {
                    row[i] = ' ';
                }
            }
            _ => {}
        }
    }

    fn put(&mut self, c: char) {
        if self.col >= self.cols {
            self.row += 1;
            self.col = 0;
            self.grow();
        }
        let col = self.col;
        let row = &mut self.rows[self.row];
        while row.len() < col {
            row.push(' ');
        }
        if col < row.len() {
            row[col] = c;
        } else {
            row.push(c);
        }
        self.col += 1;
    }

    fn grow(&mut self) {
        while self.rows.len() <= self.row {
            self.rows.push(Vec::new());
        }
    }

    /// What a human would read off the pane.
    fn text(&self) -> String {
        let mut lines: Vec<String> = self
            .rows
            .iter()
            .map(|r| r.iter().collect::<String>().trim_end().to_string())
            .collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines.join("\n")
    }
}

/// The pane with the deliberately boring part folded up, so a stranded line is
/// still obvious in a failure without 200 lines of `seq` output around it.
fn readable(pane: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut run = 0usize;
    for line in pane.lines() {
        if line.trim().parse::<u32>().is_ok() {
            run += 1;
            continue;
        }
        if run > 0 {
            out.push(format!("   ... {run} lines of numbers ..."));
            run = 0;
        }
        out.push(line.to_string());
    }
    if run > 0 {
        out.push(format!("   ... {run} lines of numbers ..."));
    }
    out.join("\n")
}

fn blank_to(row: &mut Vec<char>, col: usize) {
    for i in 0..col.min(row.len()) {
        row[i] = ' ';
    }
}

// ---------------------------------------------------------------------------
// Wiring: one tap feeding both the engine and the terminal
// ---------------------------------------------------------------------------

/// The production tap does exactly this: the engine is told everything, and the
/// pane is told everything the curtain is not holding back. Here the pane is a
/// `Term`, so what is asserted on is what the operator would have seen.
///
/// The order matters and is the production order: filter first, send second, so
/// that a prompt mark inside a chunk has already lifted the curtain by the time
/// the engine reads that chunk.
struct Tap {
    tx: mpsc::UnboundedSender<TapMsg>,
    raw: Arc<Mutex<Vec<u8>>>,
    curtain: Curtain,
}

impl PtyEvents for Tap {
    fn data(&self, payload: PtyData) {
        let shown = self.curtain.filter(&payload.data).to_vec();
        self.raw.lock().unwrap().extend_from_slice(&shown);
        let _ = self.tx.send(TapMsg::Data(payload.data));
    }
    fn closed(&self, _payload: PtyClosed) {
        let _ = self.tx.send(TapMsg::Closed);
    }
    fn block(&self, _payload: PtyBlock) {}
    fn sudo_injected(&self, _payload: SudoInjected) {}
    fn sudo_rejected(&self, _payload: SudoInjected) {}
}

#[derive(Default)]
struct Events(Mutex<Vec<SkillProgress>>);

impl SkillEvents for Events {
    fn progress(&self, payload: SkillProgress) {
        self.0.lock().unwrap().push(payload);
    }
    fn paused(&self, payload: SkillPaused) {
        panic!("nothing in this sequence may park: {payload:?}");
    }
    fn done(&self, _payload: SkillDone) {}
}

impl Events {
    /// The steps that announced themselves, in order.
    fn steps(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.step_kind.is_some())
            .filter_map(|p| p.step_id.clone())
            .collect()
    }
    fn log(&self) -> String {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|p| {
                format!(
                    "{:>8} {:<12} {}",
                    p.phase,
                    p.step_id.clone().unwrap_or_default(),
                    p.detail
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

// ---------------------------------------------------------------------------
// The skill
// ---------------------------------------------------------------------------

fn run(id: &str, command: &str, on_success: &str, on_failure: &str) -> SeqStep {
    SeqStep::Run {
        id: id.into(),
        command: command.into(),
        interactive: false,
        timeout_secs: Some(25),
        // Nothing here may park: a parked run waits for an operator who does not
        // exist, which in a test is a hang rather than a failure.
        on_timeout: TimeoutAction::Fail,
        on_timeout_target: None,
        on_success: on_success.into(),
        on_failure: on_failure.into(),
        r#match: None,
    }
}

fn interactive(mut step: SeqStep) -> SeqStep {
    if let SeqStep::Run { interactive, .. } = &mut step {
        *interactive = true;
    }
    step
}

fn matching(mut step: SeqStep, pattern: &str, if_match: &str, if_no_match: &str) -> SeqStep {
    if let SeqStep::Run { r#match, .. } = &mut step {
        *r#match = Some(MatchBranch {
            pattern: pattern.into(),
            if_match: if_match.into(),
            if_no_match: if_no_match.into(),
        });
    }
    step
}

fn expect(id: &str, pattern: &str, send: Option<&str>, on_match: &str) -> SeqStep {
    SeqStep::Expect {
        id: id.into(),
        pattern: pattern.into(),
        send_on_match: send.map(str::to_string),
        timeout_secs: Some(25),
        on_timeout: TimeoutAction::Fail,
        on_timeout_target: None,
        on_match: on_match.into(),
    }
}

fn log(id: &str, level: LogLevel, message: &str, next: &str) -> SeqStep {
    SeqStep::Log {
        id: id.into(),
        level,
        message: message.into(),
        next: next.into(),
    }
}

/// One skill covering what an operator's skill actually does to a host: escalate
/// into a nested shell, test for something and branch on the answer, read a
/// command's output rather than its exit code, produce a lot of output, produce
/// none, answer an interactive prompt, leave the nested shell again, and wait.
fn sequence() -> SequenceConfig {
    SequenceConfig {
        params: vec![],
        start_step_id: "escalate".into(),
        allow_transfer: true,
        max_step_repeats: None,
        unlimited_step_repeats: false,
        steps: vec![
            // A nested root shell, whose password prompt the injector answers
            // and which has none of the OSC 133 hooks in it.
            interactive(run("escalate", "sudo -i", "amiroot", STOP)),
            // Output branching: `id -un` says root, and the word is nowhere in
            // the command, so a match here cannot be reading the echo.
            matching(
                run("amiroot", "id -un", STOP, STOP),
                "root",
                "nginx",
                "notroot",
            ),
            log("notroot", LogLevel::Error, "the escalation did not take", STOP),
            // Exit-code branching, on a host that certainly has no nginx.
            run("nginx", "test -f /etc/nginx/nginx.conf", "hasnginx", "nonginx"),
            log("hasnginx", LogLevel::Error, "this host was meant to be bare", STOP),
            log("nonginx", LogLevel::Warn, "nginx is not installed", "chatty"),
            // A lot of output, then none at all, then output with colour in it.
            run("chatty", "seq 1 200", "quiet", STOP),
            run("quiet", "true", "coloured", STOP),
            run(
                "coloured",
                "printf '\\033[32mgreen\\033[0m\\n'",
                "askme",
                STOP,
            ),
            // An interactive program: it prints a prompt with no newline and
            // waits, so the step advances on quiet and the answer is expected.
            interactive(run("askme", "ask-confirm", "answer", STOP)),
            expect("answer", "Continue\\?", Some("yes\\n"), "confirmed"),
            expect("confirmed", "confirmed-yes", None, "leave"),
            // Literal keys, and the way back out of the nested shell.
            SeqStep::Send {
                id: "leave".into(),
                input: "exit\\n".into(),
                next: "whoami".into(),
            },
            // Back in the login shell, which still has its hooks: the offer is
            // made again and answered `y` without installing anything.
            matching(
                run("whoami", "whoami", STOP, STOP),
                USER,
                "hold",
                "stillroot",
            ),
            log("stillroot", LogLevel::Error, "the exit did not take", STOP),
            SeqStep::Wait {
                id: "hold".into(),
                seconds: 2,
                next: "failing".into(),
            },
            // A command that fails, taking the failure branch on purpose.
            run("failing", "false", "unexpected", "expected"),
            log("unexpected", LogLevel::Error, "false succeeded", STOP),
            log("expected", LogLevel::Info, "false failed, as it should", STOP),
        ],
    }
}

// ---------------------------------------------------------------------------

async fn trust(host: &SkillsHost) -> String {
    let first = probe(
        "127.0.0.1",
        host.port,
        USER,
        vec![],
        AuthMethod::Password(PASSWORD.to_string()),
    )
    .await
    .expect("probe failed");
    match first {
        ProbeResult::UnknownKey { key } => key.fingerprint_sha256,
        other => panic!("expected UnknownKey on first contact, got {other:?}"),
    }
}

/// Everything the operator would have seen, plus how the run went.
struct Ran {
    pane: String,
    outcome: broadside_lib::ssh::skill_run::HostOutcome,
    events: Arc<Events>,
}

async fn drive(cols: u32, shell: &str) -> Ran {
    let host = SkillsHost::start_with_shell(&format!("/bin/{shell}"));
    let fingerprint = trust(&host).await;

    let raw = Arc::new(Mutex::new(Vec::new()));
    let (tap_tx, tap_rx) = mpsc::unbounded_channel();
    let (_ctl_tx, ctl_rx) = mpsc::unbounded_channel::<Ctl>();
    let pty_state = PtyState::default();
    let session_id = "skill-pane-session".to_string();
    let curtain = Curtain::new();

    let opened = open(
        Tap {
            tx: tap_tx,
            raw: raw.clone(),
            curtain: curtain.clone(),
        },
        &pty_state,
        session_id.clone(),
        "skills-test",
        "127.0.0.1",
        host.port,
        USER,
        vec![fingerprint],
        AuthMethod::Password(PASSWORD.to_string()),
        Some(PASSWORD.to_string()),
        ShellIntegrationPref::Auto,
        cols,
        ROWS,
    )
    .await
    .expect("open failed");

    let PtyOpenResult::Opened {
        login_shell,
        capability,
        integration,
    } = opened
    else {
        panic!("expected an opened session, got {opened:?}");
    };
    assert_eq!(login_shell.as_deref(), Some(shell), "wrong login shell");

    let write_state = pty_state.clone();
    let write_id = session_id.clone();
    let link = PtyLink {
        rx: tap_rx,
        write: Box::new(move |bytes: &[u8]| write_state.write(&write_id, bytes)),
        curtain,
    };
    let events = Arc::new(Events::default());
    let engine = Engine::new(
        link,
        ctl_rx,
        events.clone(),
        HostMeta {
            run_id: "skill-pane".into(),
            host_id: 1,
            label: "skills-test".into(),
            session_id: session_id.clone(),
        },
    )
    .with_known_shell(login_shell)
    .with_known_capability(capability)
    .with_integration_sent(integration.resolve(capability).with_integration());

    // The same preparation the app does before a run: it validates the graph and
    // it is where an authored `\n` becomes a real newline. Skipping it sent the
    // interactive answer as the two literal characters, which is a fine way to
    // learn that the engine does not unescape at send time.
    let cfg = prepare(&sequence(), &HashMap::new()).expect("the sequence is well formed");
    let outcome = tokio::time::timeout(Duration::from_secs(240), run_host(engine, &cfg))
        .await
        .expect("the run never finished");

    // Render everything the host said, exactly as the pane would have.
    let mut term = Term::new(cols as usize);
    term.feed(&String::from_utf8_lossy(&raw.lock().unwrap()));
    let pane = term.text();
    println!("--------------- pane at {cols} columns ---------------\n{}", readable(&pane));
    println!("---------------- log -----------------\n{}", events.log());
    Ran {
        pane,
        outcome,
        events,
    }
}

/// Nothing of Broadside's own may be on the glass at any width. Split out
/// because it is the assertion that matters, and it is made at more than one.
fn assert_no_plumbing(pane: &str) {
    // The visible completion wrapper is the fallback for a shell that cannot
    // report its own completions. Every shell in this suite can.
    assert!(
        !pane.contains("__bsdone"),
        "the run fell back to the visible marker:\n{}",
        readable(pane)
    );
    for plumbing in [
        "stty", "__bsecho", "__bshook", "__bsshell", "__bsuid", "6273", "__omni_precmd",
        "PROMPT_COMMAND",
    ] {
        assert!(
            !pane.contains(plumbing),
            "{plumbing:?} was left on the operator's screen:\n{}",
            readable(pane)
        );
    }
}

#[tokio::test]
#[ignore]
async fn a_whole_skill_runs_without_putting_anything_of_its_own_on_the_screen() {
    let Ran {
        pane,
        outcome,
        events,
    } = drive(120, "bash").await;

    // 1. The run did what the skill said, all the way to the end.
    assert!(outcome.ok, "{outcome:?}\n{}", events.log());
    assert_eq!(
        events.steps(),
        vec![
            "escalate", "amiroot", "nginx", "nonginx", "chatty", "quiet", "coloured", "askme",
            "answer", "confirmed", "leave", "whoami", "hold", "failing", "expected",
        ],
        "the skill took a different path:\n{}",
        events.log()
    );
    // The uid probe at the end of the run reads the shell the `exit` left us in.
    assert_eq!(outcome.is_root, Some(false), "{outcome:?}");

    // 2. The commands the operator asked for are on the screen, once each.
    for command in [
        "sudo -i",
        "id -un",
        "test -f /etc/nginx/nginx.conf",
        "seq 1 200",
        "ask-confirm",
        "whoami",
        "false",
    ] {
        let seen: Vec<&str> = pane.lines().filter(|l| l.contains(command)).collect();
        assert_eq!(
            seen.len(),
            1,
            "{command:?} should appear on exactly one row, and is on {}:\n{}\n\nfull pane:\n{}",
            seen.len(),
            seen.join("\n"),
            readable(&pane)
        );
        // And it starts where a typed command starts. The prompt ends in a
        // space of its own, so a leading space on the line the engine sends
        // shows up as a gap the operator has no way to account for. Build 57
        // shipped with one.
        let row = seen[0];
        let at = row.find(command).expect("the row this was found on");
        assert!(
            !row[..at].ends_with("  "),
            "{command:?} sits away from the prompt: {row:?}"
        );
    }
    // And so is what they produced.
    for output in ["200", "green", "Continue? yes", "confirmed-yes"] {
        assert!(
            pane.contains(output),
            "{output:?} missing from the pane:\n{pane}"
        );
    }

    // 3. Nothing of Broadside's own is, which is the whole point.
    assert_no_plumbing(&pane);
}

/// The same run in a pane the width of a plain terminal.
///
/// The width that found build 56-3: the erase counted rows, the echoed line was
/// 67 characters, and 80 columns is where that wraps. It is not an exotic case,
/// it is the default size of every terminal ever made and roughly what a tile in
/// a four-up grid gets, so it stays in the suite as the width most likely to be
/// real even though the mechanism it caught is gone.
#[tokio::test]
#[ignore]
async fn the_same_skill_in_an_eighty_column_pane_is_just_as_clean() {
    let Ran { pane, outcome, .. } = drive(80, "bash").await;
    assert!(outcome.ok, "{outcome:?}");
    assert_no_plumbing(&pane);
}

/// zsh, whose line editor draws the line it is editing itself rather than
/// letting the terminal echo it.
///
/// That used to be a tier of its own. `stty -echo` does not stop ZLE drawing, so
/// the engine could not hide a long payload there, would not offer zsh the
/// hooks, and zsh fell back to the visible completion marker for the whole run.
/// Hiding no longer asks the shell for anything, so zsh is now held to exactly
/// the standard bash is: a clean pane **and** the shell's own completions.
#[tokio::test]
#[ignore]
async fn the_same_skill_on_zsh() {
    let Ran {
        pane,
        outcome,
        events,
    } = drive(100, "zsh").await;
    assert!(outcome.ok, "{outcome:?}\n{}", events.log());
    assert_no_plumbing(&pane);
}

/// Forty columns, which is narrower than anybody works in.
///
/// This is the question smoke test 56-4 was left open on. The erase took back a
/// fixed number of rows, so there was always some width at which the prompt plus
/// the shortest line the engine could type would not fit on one of them, and the
/// only honest answer about where that width was had to come from an operator
/// trying it. Nothing is drawn now, so nothing can wrap, and the answer is that
/// there is no such width. Asserted here rather than asked, at a width chosen to
/// be absurd: the real commands in the sequence wrap freely at 40 columns, which
/// is the operator's business, and Broadside's own lines are still nowhere.
#[tokio::test]
#[ignore]
async fn a_pane_far_too_narrow_to_be_reasonable_is_still_clean() {
    let Ran { pane, outcome, .. } = drive(40, "bash").await;
    assert!(outcome.ok, "{outcome:?}");
    assert_no_plumbing(&pane);
}
