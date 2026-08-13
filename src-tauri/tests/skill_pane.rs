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

/// The host this run is driven against: how wide the pane is, which shell logs
/// in, what its prompt looks like, and whether Broadside is allowed to write to
/// it on connect.
///
/// A struct rather than four positional arguments because the last two are the
/// ones the operator can change from the Hosts tab, and a call that reads
/// `drive(80, "bash", None, Auto)` says nothing about which of those is which.
struct Spec {
    cols: u32,
    shell: &'static str,
    /// Lines appended to the login shell's rc before the first connection, so
    /// whatever they set is already in force at the very first prompt.
    rc: Vec<String>,
    integration: ShellIntegrationPref,
    /// The operator's **Where to log** answer: true is "Skill Log Only", which
    /// asks each shell to stop keeping a history of its own.
    quiet_history: bool,
    /// A shell history that was already on the host before Broadside connected.
    seed_history: Option<&'static str>,
}

impl Spec {
    fn bash(cols: u32) -> Self {
        Spec {
            cols,
            shell: "bash",
            rc: Vec::new(),
            integration: ShellIntegrationPref::Auto,
            quiet_history: false,
            seed_history: None,
        }
    }
    fn shell(mut self, shell: &'static str) -> Self {
        self.shell = shell;
        self
    }
    fn rc(mut self, line: &str) -> Self {
        self.rc.push(line.to_string());
        self
    }
    fn ps1(self, ps1: &str) -> Self {
        self.rc(&format!("PS1='{ps1}'"))
    }
    /// The host set to **Shell integration: Never**, which is the operator
    /// saying "write nothing to this machine".
    fn untouched(mut self) -> Self {
        self.integration = ShellIntegrationPref::Never;
        self
    }
    fn quiet_history(mut self) -> Self {
        self.quiet_history = true;
        self
    }
    fn seed_history(mut self, seed: &'static str) -> Self {
        self.seed_history = Some(seed);
        self
    }
    fn rc_file(&self) -> &'static str {
        if self.shell == "zsh" {
            ".zshrc"
        } else {
            ".bashrc"
        }
    }
    fn history_file(&self) -> &'static str {
        if self.shell == "zsh" {
            ".zsh_history"
        } else {
            ".bash_history"
        }
    }
}

async fn drive(spec: Spec) -> Ran {
    drive_config(spec, sequence()).await.0
}

/// The same, for a sequence of the test's own choosing, and handing back what
/// the shell wrote to its history file on the way out as well as the pane.
///
/// Reading the history is why a caller has to end its sequence by leaving the
/// shell: bash and zsh both write the file when they exit, so a run that hands
/// the shell back still open has left nothing to read yet.
async fn drive_config(spec: Spec, cfg: SequenceConfig) -> (Ran, String) {
    let host = SkillsHost::start_with_shell(&format!("/bin/{}", spec.shell));
    for line in &spec.rc {
        host.append_rc(spec.rc_file(), line);
    }
    if let Some(seed) = spec.seed_history {
        // Both shells, because both are asked to stop recording and either could
        // take that as licence to write an empty list over what was there.
        host.seed_file(
            &format!("/home/{USER}/{}", spec.history_file()),
            USER,
            seed,
        );
        host.seed_file("/root/.bash_history", "root", seed);
    }
    let Spec {
        cols,
        shell,
        integration: pref,
        quiet_history,
        ..
    } = spec;
    let history_file = spec.history_file();
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
        pref,
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
    // The probe's own answer, and then the resolved one, exactly as the run
    // command hands them over: a host told "never" is still bash, and is still
    // drivable, it just gets no hooks and so no quiet completions.
    .with_known_capability(capability)
    .with_integration_sent(integration.resolve(capability).with_integration())
    .with_quiet_history(quiet_history);

    // The same preparation the app does before a run: it validates the graph and
    // it is where an authored `\n` becomes a real newline. Skipping it sent the
    // interactive answer as the two literal characters, which is a fine way to
    // learn that the engine does not unescape at send time.
    let cfg = prepare(&cfg, &HashMap::new()).expect("the sequence is well formed");
    let outcome = tokio::time::timeout(Duration::from_secs(240), run_host(engine, &cfg))
        .await
        .expect("the run never finished");

    // Both histories: the login shell's, and the one belonging to the shell a
    // `sudo -i` opened, which is a different shell with a different file and is
    // the half a per-host mechanism would miss.
    let history = format!(
        "{}{}",
        host.read_home_file(history_file),
        host.read_as_root("/root/.bash_history")
    );

    // Render everything the host said, exactly as the pane would have.
    let mut term = Term::new(cols as usize);
    term.feed(&String::from_utf8_lossy(&raw.lock().unwrap()));
    let pane = term.text();
    println!(
        "--------------- {shell} at {cols} columns{}{} ---------------\n{}",
        if pref == ShellIntegrationPref::Never { ", no integration" } else { "" },
        if quiet_history { ", history off" } else { "" },
        readable(&pane)
    );
    println!("---------------- log -----------------\n{}", events.log());
    (
        Ran {
            pane,
            outcome,
            events,
        },
        history,
    )
}

/// Nothing of Broadside's own may be on the glass at any width. Split out
/// because it is the assertion that matters, and it is made at more than one.
fn assert_no_plumbing(pane: &str) {
    // The visible completion wrapper is the fallback for a shell that cannot
    // report its own completions. Every shell in this suite can, bar the host
    // whose operator told Broadside to write nothing to it.
    assert!(
        !pane.contains("__bsdone"),
        "the run fell back to the visible marker:\n{}",
        readable(pane)
    );
    assert_nothing_hidden_leaked(pane);
}

/// The half of that which holds even where the visible wrapper is expected.
///
/// The wrapper is the one line of Broadside's the operator is *meant* to read:
/// it is appended to their own command, in plain sight, because a shell with no
/// hooks has no other way to report an exit code. Everything else here is a
/// question the engine asked the shell, and the curtain hides those by never
/// forwarding them, which owes nothing to the shell integration. So a host set
/// to Never is held to exactly this standard, and it is the standard that
/// matters: the wrapper is explainable, a stray `stty` is not.
fn assert_nothing_hidden_leaked(pane: &str) {
    for plumbing in [
        "stty", "__bsecho", "__bshook", "__bsshell", "__bsuid", "6273", "__omni_precmd",
        "PROMPT_COMMAND",
        // Asking the shell to stop keeping a history is Broadside's business
        // like any other question it asks, and rides on a line the curtain is
        // already holding back.
        "set +o history",
        "fc -p",
        "BASH_VERSION",
    ] {
        assert!(
            !pane.contains(plumbing),
            "{plumbing:?} was left on the operator's screen:\n{}",
            readable(pane)
        );
    }
}

/// Whether this host is one the engine has to append the visible completion
/// marker for, which changes what a command's row is allowed to look like.
#[derive(PartialEq)]
enum Wrapped {
    No,
    Yes,
}

/// Every command the skill's author wrote, on exactly one row of the pane, and
/// starting where a command somebody typed starts.
///
/// The second half is the one build 57 shipped without. A prompt ends in a
/// space of its own, so a leading space on the line the engine sends reads as a
/// gap the operator cannot account for. The line the engine *composed* still
/// carries one, deliberately, because that is what keeps it out of the shell's
/// history: on a host with the wrapper the gap is the rule working, so only the
/// two interactive steps, which are sent verbatim either way, are checked
/// there.
///
/// Only called where the pane is wide enough for these to fit on one row.
/// Wrapping a long command in a narrow pane is the pane being narrow.
fn assert_commands_read_like_typing(pane: &str, wrapped: Wrapped) {
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
            readable(pane)
        );
        let sent_verbatim = matches!(command, "sudo -i" | "ask-confirm");
        if wrapped == Wrapped::Yes && !sent_verbatim {
            continue;
        }
        let row = seen[0];
        let at = row.find(command).expect("the row this was found on");
        assert!(
            !row[..at].ends_with("  "),
            "{command:?} sits away from the prompt: {row:?}"
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
    } = drive(Spec::bash(120)).await;

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
    assert_commands_read_like_typing(&pane, Wrapped::No);
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
    let Ran { pane, outcome, .. } = drive(Spec::bash(80)).await;
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
    } = drive(Spec::bash(100).shell("zsh")).await;
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
    let Ran { pane, outcome, .. } = drive(Spec::bash(40)).await;
    assert!(outcome.ok, "{outcome:?}");
    assert_no_plumbing(&pane);
}

/// A prompt long enough that the operator's own commands wrap, in a pane narrow
/// enough to make them (smoke 57-2 B3).
///
/// The interesting part is not the length, it is that Broadside no longer has
/// an opinion about it. The old erase took back a number of rows it worked out
/// from the width and the length of what it had typed, so a prompt like this
/// one moved the answer, and a prompt with a git branch in it moved the answer
/// again every time the branch changed. Nothing is drawn now, so the pane's
/// arithmetic has nobody doing it.
///
/// Sixty columns against a prompt sixty-four characters wide, so the prompt
/// itself is more than one row before a command is even typed. The commands are
/// deliberately not checked for sitting on one row: at this width they wrap,
/// which is the pane being narrow and is the operator's own business.
#[tokio::test]
#[ignore]
async fn a_long_prompt_in_a_narrow_pane() {
    let Ran { pane, outcome, .. } = drive(
        Spec::bash(60).ps1("\\u@skills-test.internal.example.com:\\w (feat/prompts80) \\$ "),
    )
    .await;
    assert!(outcome.ok, "{outcome:?}");
    // The prompt actually took, or this test proves nothing about long prompts.
    // Matched on the part that survives the wrap: the tail of the prompt is on
    // the row below, which is the whole point of the width.
    assert!(
        pane.contains("skills-test.internal.example.com"),
        "the fixture's own prompt never reached the pane:\n{}",
        readable(&pane)
    );
    assert_no_plumbing(&pane);
}

/// A two-line prompt (smoke 57-2 B4), which the old erase could never have
/// survived: it took back one row, and a prompt that is two rows tall means the
/// row above the one it cleared is the top half of a prompt.
///
/// Wide enough that the commands still fit on one row, so this is also where
/// the prompt-to-command gap is checked against a prompt that is not the one
/// Debian ships.
#[tokio::test]
#[ignore]
async fn a_two_line_prompt_keeps_both_of_its_lines() {
    let Ran {
        pane,
        outcome,
        events,
    } = drive(Spec::bash(100).ps1("[\\u@skills-test.internal.example.com \\w]\\n\\$ ")).await;
    assert!(outcome.ok, "{outcome:?}\n{}", events.log());
    // Both halves are on the glass, and the top half as many times as the
    // bottom: one eaten row is the whole failure this is looking for.
    let tops = pane
        .lines()
        .filter(|l| l.contains("[skilltest@skills-test.internal.example.com"))
        .count();
    // `$`, not `"$ "`: a row is read off the pane with its trailing blanks
    // trimmed, so the last prompt, the one with nothing typed at it, is a bare
    // dollar sign. That row is the one an eaten line would most likely be.
    let bottoms = pane.lines().filter(|l| l.starts_with('$')).count();
    assert!(tops > 3, "the prompt's first line is missing:\n{}", readable(&pane));
    assert_eq!(
        tops, bottoms,
        "a prompt lost half of itself: {tops} first lines against {bottoms} second:\n{}",
        readable(&pane)
    );
    assert_commands_read_like_typing(&pane, Wrapped::No);
    assert_no_plumbing(&pane);
}

// ---------------------------------------------------------------------------
// What the operator's shell remembers afterwards
// ---------------------------------------------------------------------------

/// A short skill that leaves the shell, so it writes its history file before
/// the test reads it. Both shells write on exit and not before, so a run that
/// hands the shell back still open has left nothing to read.
///
/// `sudo -i` is in here on purpose. History belongs to a shell rather than a
/// host, so the root shell it opens has never heard of any of this, and
/// `remember-me-root` is the command that says whether the engine asked the new
/// shell the same question it asked the old one.
fn history_sequence() -> SequenceConfig {
    SequenceConfig {
        params: vec![],
        start_step_id: "one".into(),
        // No transfer, so `run_host` skips the uid probe: this sequence ends by
        // closing the shell and there is nothing left to probe.
        allow_transfer: false,
        max_step_repeats: None,
        unlimited_step_repeats: false,
        steps: vec![
            run("one", "echo remember-me-login", "escalate", STOP),
            interactive(run("escalate", "sudo -i", "two", STOP)),
            run("two", "echo remember-me-root", "leave", STOP),
            SeqStep::Send {
                id: "leave".into(),
                input: "exit\\n".into(),
                next: "out".into(),
            },
            SeqStep::Send {
                id: "out".into(),
                input: "exit\\n".into(),
                next: STOP.into(),
            },
        ],
    }
}

/// The setting that leaves things as they were. Run first as the control: a
/// "nothing was recorded" assertion is worth nothing until something has proved
/// this host records anything at all.
#[tokio::test]
#[ignore]
async fn remote_history_only_leaves_the_commands_where_they_have_always_been() {
    let (ran, history) = drive_config(Spec::bash(100), history_sequence()).await;
    println!("--------------- both histories ---------------\n{history}");
    assert_ran(&ran);
    for command in ["echo remember-me-login", "echo remember-me-root"] {
        assert!(
            history.contains(command),
            "the fixture records nothing, so this suite cannot tell whether \
             Broadside stopped it: {command:?} missing from\n{history}"
        );
    }
}

/// Both commands really ran.
///
/// Every assertion in this section is about something **not** being in a file,
/// and a run that died on its first line satisfies all of them. It nearly did:
/// the first version of the history-off line abandoned the rest of the command
/// line on zsh, so the run never started, the history was empty, and the test
/// went green. This is what makes the emptiness mean anything.
fn assert_ran(ran: &Ran) {
    assert_eq!(
        ran.events.steps(),
        vec!["one", "escalate", "two", "leave", "out"],
        "the run did not do what it was asked, so an empty history proves \
         nothing:\n{}",
        ran.events.log()
    );
    for echoed in ["remember-me-login", "remember-me-root"] {
        assert!(
            ran.pane.contains(echoed),
            "{echoed:?} never reached the pane:\n{}",
            readable(&ran.pane)
        );
    }
    // And the pane is held to the same standard as everywhere else, under the
    // setting that types one more thing at the host than any other.
    assert_no_plumbing(&ran.pane);
}

/// And the setting that does not (prompts80). The engine asks each shell to
/// stop keeping a record, on the same line it asks about the OSC 133 hooks, so
/// the question is re-asked at exactly the moments the shell can have changed.
#[tokio::test]
#[ignore]
async fn skill_log_only_leaves_nothing_in_the_hosts_own_history() {
    let (ran, history) =
        drive_config(Spec::bash(100).quiet_history(), history_sequence()).await;
    println!("--------------- both histories ---------------\n{history}");
    assert_ran(&ran);
    // Both shells, and the second is the one the mechanism could plausibly miss:
    // the root shell a `sudo -i` opens is a different shell with its own
    // history, and it is the first step of most skills.
    for command in ["remember-me-login", "remember-me-root"] {
        assert!(
            !history.contains(command),
            "{command:?} was recorded on the host after all:\n{history}"
        );
    }
    // Nor any of Broadside's own plumbing, which is the same promise from the
    // other end.
    for plumbing in ["__bsshell", "__bsuid", "__bshook", "set +o history"] {
        assert!(
            !history.contains(plumbing),
            "{plumbing:?} was recorded on the host:\n{history}"
        );
    }
}

/// The operator's own history was there before Broadside was, and has to be
/// there afterwards (smoke 58 A4).
///
/// This is the question that makes the mechanism safe or not, and neither shell
/// answers it obviously. bash reads its history file into memory at login and
/// writes that list back out on exit, so turning recording off has to mean
/// "stop adding" and not "start from empty", or the file comes back truncated.
/// zsh's `fc -p` switches to a new history with no file behind it, and whether
/// the real one survives the shell exiting with that still on the stack is a
/// claim rather than a fact until it is run.
///
/// A skill that quietly emptied somebody's `.bash_history` would be a far worse
/// bug than the one this feature exists to fix.
#[tokio::test]
#[ignore]
async fn a_history_that_was_already_there_survives_a_quiet_run() {
    const BEFORE: &str = "echo i-was-here-before";
    for shell in ["bash", "zsh"] {
        let spec = Spec::bash(100)
            .shell(shell)
            .quiet_history()
            .seed_history(BEFORE)
            .rc("HISTFILE=$HOME/.zsh_history")
            .rc("SAVEHIST=1000")
            .rc("HISTSIZE=1000");
        let (ran, history) = drive_config(spec, history_sequence()).await;
        println!("--------------- {shell}, both histories ---------------\n{history}");
        assert_ran(&ran);
        // Twice over: the login shell's file and root's, because a `sudo -i`
        // opens a second shell that is asked the same thing and could destroy a
        // second file.
        assert_eq!(
            history.matches(BEFORE).count(),
            2,
            "a run erased history that was not its to erase ({shell}):\n{history}"
        );
        // And it still did not add its own.
        assert!(
            !history.contains("remember-me"),
            "{shell} recorded the skill's commands after all:\n{history}"
        );
    }
}

/// zsh has no `history` option to turn off, so it gets `fc -p` instead: a fresh
/// history with no file behind it, pushed over the real one. Same promise, said
/// in zsh's own terms, and worth its own run because the two shells share none
/// of the mechanism.
///
/// The rc lines are the fixture admitting that a bare zsh keeps no history at
/// all: with `HISTFILE` unset there is nothing to write to, and a test that
/// passed because of that would be proving nothing.
#[tokio::test]
#[ignore]
async fn skill_log_only_on_zsh_which_has_no_switch_to_turn_off() {
    let zsh = || {
        Spec::bash(100)
            .shell("zsh")
            .rc("HISTFILE=$HOME/.zsh_history")
            .rc("SAVEHIST=1000")
            .rc("HISTSIZE=1000")
    };
    let (control_run, control) = drive_config(zsh(), history_sequence()).await;
    println!("--------------- zsh control ---------------\n{control}");
    assert_ran(&control_run);
    assert!(
        control.contains("echo remember-me-login"),
        "the zsh fixture records nothing, so this proves nothing:\n{control}"
    );

    let (ran, history) = drive_config(zsh().quiet_history(), history_sequence()).await;
    println!("--------------- zsh, history off ---------------\n{history}");
    assert_ran(&ran);
    assert!(
        !history.contains("remember-me-login"),
        "zsh kept the command anyway:\n{history}"
    );
}

/// A host set to **Shell integration: Never** (smoke 57-2 D3): the operator has
/// said Broadside may not write to this machine, so it gets no OSC 133 hooks and
/// cannot report its own completions.
///
/// Two things have to hold at once here, and they pull in opposite directions.
/// The visible completion marker *must* come back, because with no hooks there
/// is no other way to read an exit code, and it must carry its leading space,
/// because it is Broadside's line and has no business in the operator's history.
/// Everything the engine asks the shell must still be nowhere, because the
/// curtain hides by not forwarding and owes nothing to the integration. This is
/// also the only case in the suite where a hidden line has no prompt mark to
/// wait for, so it lifts on the engine's own answer and clears its own row.
#[tokio::test]
#[ignore]
async fn a_host_broadside_may_not_write_to_still_runs_the_skill() {
    let Ran {
        pane,
        outcome,
        events,
    } = drive(Spec::bash(100).untouched()).await;
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
    // The fallback is in use, in plain sight, and with the space that keeps it
    // out of the history an operator reaches with Up.
    let wrapped: Vec<&str> = pane
        .lines()
        .filter(|l| l.contains("__bsdone_") && l.contains("printf"))
        .collect();
    assert!(
        wrapped.len() >= 4,
        "the visible marker should be on every non-interactive command's row, and is on {}:\n{}",
        wrapped.len(),
        readable(&pane)
    );
    for row in &wrapped {
        let at = row.find("test -f").or_else(|| row.find("whoami")).or_else(|| row.find("false"));
        if let Some(at) = at {
            assert!(
                row[..at].ends_with("  "),
                "the wrapped line lost the space that keeps it out of history: {row:?}"
            );
        }
    }
    assert_commands_read_like_typing(&pane, Wrapped::Yes);
    // And nothing the engine asked the shell, which is the part that does not
    // change with the integration.
    assert_nothing_hidden_leaked(&pane);
}
