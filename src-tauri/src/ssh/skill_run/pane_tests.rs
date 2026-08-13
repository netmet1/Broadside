//! What the operator actually sees while the engine types.
//!
//! The fake host in [`super::tests`] answers questions and does not draw, so
//! anything wrong with the pane passes every one of its tests. This is the
//! terminal with a width in it.
//!
//! What is modelled here is the whole path: a shell that echoes what is typed
//! at it and redraws its prompt afterwards, a [`Curtain`] between that shell
//! and the glass, and a [`Pane`] that only ever receives what the curtain
//! forwards. That last part is the change these tests exist to pin down. The
//! plumbing used to be removed from the pane by a cursor-up-and-erase typed at
//! the host, and getting the row count right depended on the width of the pane,
//! the length of the prompt and whether the shell echoed at all. It was wrong
//! three times (smoke tests 56, 56-2 and 56-3). Now the plumbing is not
//! forwarded, so there is no count to get right, and
//! [`width_is_no_longer_something_the_pane_depends_on`] is the test that says
//! so.

use super::curtain::{Curtain, End};
use super::{hidden_line, hidden_line_self_repairing, screen::BS_OSC};

/// The prompt from the smoke test, so a failure here reads like the report.
const PROMPT: &str = "root@skills-host-01:~# ";
const BANNER: &str = "Last login: Wed Aug 12 21:30:32 2026 from 203.0.113.215";

/// `OSC 133 ; B`, which the integration puts on the end of `PS1`. A shell
/// running the hooks ends every prompt with it, and it is what lifts the
/// curtain.
const MARK: &str = "\u{1b}]133;B\u{7}";

/// A terminal, in the only dimensions this cares about: rows of text, a width to
/// wrap at, and where the cursor sits.
struct Pane {
    rows: Vec<Vec<char>>,
    row: usize,
    col: usize,
    cols: usize,
}

impl Pane {
    fn new(cols: usize) -> Self {
        Pane {
            rows: vec![Vec::new()],
            row: 0,
            col: 0,
            cols,
        }
    }

    fn feed(&mut self, out: &str) {
        let mut it = out.chars().peekable();
        while let Some(c) = it.next() {
            match c {
                '\u{1b}' => match it.next() {
                    Some('[') => {
                        let mut num = String::new();
                        let action = loop {
                            match it.next() {
                                Some(d) if d.is_ascii_digit() => num.push(d),
                                Some(a) => break a,
                                None => return,
                            }
                        };
                        match action {
                            'A' => {
                                let n = num.parse::<usize>().unwrap_or(1).max(1);
                                self.row = self.row.saturating_sub(n);
                            }
                            // Erase in display, from the cursor down. Every use
                            // here is the default (0) form.
                            'J' => self.erase_below(),
                            // Erase in line. `2` is the whole row, which is the
                            // only form the engine sends.
                            'K' => {
                                if num == "2" {
                                    self.rows[self.row].clear();
                                } else {
                                    self.rows[self.row].truncate(self.col);
                                }
                            }
                            _ => {}
                        }
                    }
                    // An OSC is addressed to the terminal, not to the glass:
                    // swallowed to its terminator, and nothing is drawn.
                    Some(']') => {
                        for t in it.by_ref() {
                            if t == '\u{7}' {
                                break;
                            }
                        }
                    }
                    _ => {}
                },
                // ONLCR: a newline out of a tty is carriage return and line feed.
                '\n' => self.next_row(),
                '\r' => self.col = 0,
                _ => self.put(c),
            }
        }
    }

    fn next_row(&mut self) {
        self.row += 1;
        self.col = 0;
        while self.rows.len() <= self.row {
            self.rows.push(Vec::new());
        }
    }

    fn put(&mut self, c: char) {
        if self.col >= self.cols {
            self.next_row();
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

    fn erase_below(&mut self) {
        self.rows[self.row].truncate(self.col);
        self.rows.truncate(self.row + 1);
    }

    /// What a human would read off the pane: trailing spaces are not text, and
    /// neither is a run of blank rows under the cursor.
    fn snapshot(&self) -> String {
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

/// A shell at a prompt. It echoes what is typed, runs it, and draws its prompt
/// again, which is all a shell has to do for the pane to be interesting.
///
/// Note what it does **not** have any more: a way to be told to stop echoing.
/// Nothing is asked of the shell, so there is no cooperation to model and no
/// shell-shaped way for hiding to fail.
struct Shell {
    /// Whether it runs the integration, and so ends its prompt with [`MARK`].
    /// False for a plain `sh`, which parses the integration and installs
    /// nothing, and for a shell that refuses the hooks.
    hooked: bool,
    /// The prompt it draws. Its own field because a prompt that spans two rows
    /// is the case the old erase could never have survived.
    prompt: String,
    /// What a command that is not a `printf` prints. The engine's payloads
    /// answer inside an escape and print nothing, which is the point of them,
    /// so this is empty except where a test asks otherwise.
    output: String,
}

impl Shell {
    fn new() -> Self {
        Shell {
            hooked: true,
            prompt: PROMPT.to_string(),
            output: String::new(),
        }
    }

    fn prompt(&self) -> String {
        if self.hooked {
            format!("{}{MARK}", self.prompt)
        } else {
            self.prompt.clone()
        }
    }

    /// Everything the host sends in reply to one submitted line.
    fn submit(&mut self, line: &str) -> String {
        let typed = line.trim_end_matches('\n');
        let mut out = String::new();
        // Every terminal echoes what is typed at it. Unconditionally, now.
        out.push_str(typed);
        out.push('\n');
        if self.hooked {
            out.push_str("\u{1b}]133;C\u{7}");
        }
        for seg in segments(typed) {
            let seg = seg.trim();
            if seg.starts_with("printf ") {
                out.push_str(&expand_printf(seg));
            } else {
                out.push_str(&self.output.clone());
            }
        }
        if self.hooked {
            out.push_str("\u{1b}]133;D;0\u{7}\u{1b}]133;A\u{7}");
        }
        out.push_str(&self.prompt());
        out
    }
}

/// A shell, a curtain and a pane, wired the way the app wires them.
struct Session {
    sh: Shell,
    pane: Pane,
    curtain: Curtain,
}

impl Session {
    fn new(cols: usize) -> Self {
        let mut s = Session {
            sh: Shell::new(),
            pane: Pane::new(cols),
            curtain: Curtain::new(),
        };
        s.pane.feed(BANNER);
        s.pane.feed("\n");
        s.pane.feed(&s.sh.prompt());
        s
    }

    /// A session whose shell does not run the integration.
    fn unhooked(cols: usize) -> Self {
        let mut s = Session {
            sh: Shell {
                hooked: false,
                ..Shell::new()
            },
            pane: Pane::new(cols),
            curtain: Curtain::new(),
        };
        s.pane.feed(BANNER);
        s.pane.feed("\n");
        s.pane.feed(&s.sh.prompt());
        s
    }

    /// The tap: what the shell said, less what the curtain is holding back.
    fn show(&mut self, out: &str) {
        let shown = self.curtain.filter(out.as_bytes()).to_vec();
        self.pane.feed(&String::from_utf8_lossy(&shown));
    }

    /// A command the operator asked for. Nothing is hidden.
    fn command(&mut self, line: &str) {
        let out = self.sh.submit(line);
        self.show(&out);
    }

    /// One line of the engine's own plumbing, start to finish, exactly as
    /// [`super::Engine::send_hidden`] and [`super::Engine::raise_curtain`]
    /// between them drive it.
    fn hidden(&mut self, payload: &str) {
        let end = if self.sh.hooked {
            End::PromptMark
        } else {
            End::ProbeAnswer
        };
        self.curtain.lower(end);
        let line = match end {
            End::PromptMark => hidden_line(payload),
            End::ProbeAnswer => hidden_line_self_repairing(payload),
        };
        let out = self.sh.submit(&line);
        self.show(&out);
        // The engine's backstop, which repairs nothing on purpose: see
        // `Engine::raise_curtain`.
        self.curtain.raise();
    }

    /// The engine's usual pair at the start of a run: ask what shell this is,
    /// then offer it the hooks.
    fn opening_probes(&mut self) {
        self.hidden(&probe_payload("__bsshell_-bash__"));
        self.hidden(&probe_payload("__bshook_y__"));
    }

    fn snapshot(&self) -> String {
        self.pane.snapshot()
    }
}

/// Splits a command line on the semicolons that separate commands, leaving the
/// ones inside a quoted `printf` format alone.
fn segments(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (i, c) in line.char_indices() {
        match c {
            '\'' => quoted = !quoted,
            ';' if !quoted => {
                out.push(&line[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&line[start..]);
    out
}

/// Runs a `printf 'format' arg` the way a shell would: escapes interpreted, one
/// `%s` filled in.
fn expand_printf(seg: &str) -> String {
    let mut parts = seg.splitn(3, '\'');
    parts.next();
    let fmt = parts.next().unwrap_or_default();
    let arg = parts.next().unwrap_or_default().trim().trim_matches('"');
    unescape(fmt).replacen("%s", arg, 1)
}

fn unescape(fmt: &str) -> String {
    let mut out = String::new();
    let mut it = fmt.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.peek().copied() {
            Some(d) if ('0'..='7').contains(&d) => {
                let mut oct = String::new();
                while oct.len() < 3 && it.peek().is_some_and(|n| ('0'..='7').contains(n)) {
                    oct.push(it.next().expect("peeked"));
                }
                let code = u32::from_str_radix(&oct, 8).unwrap_or(0);
                out.push(char::from_u32(code).unwrap_or('?'));
            }
            Some('r') => {
                it.next();
                out.push('\r');
            }
            Some('n') => {
                it.next();
                out.push('\n');
            }
            Some('a') => {
                it.next();
                out.push('\u{7}');
            }
            Some('\\') => {
                it.next();
                out.push('\\');
            }
            _ => out.push('\\'),
        }
    }
    out
}

/// A payload of the shape the engine actually sends: a probe that answers inside
/// an escape sequence and prints nothing a terminal draws.
fn probe_payload(answer: &str) -> String {
    format!("printf '\\033]{BS_OSC};{answer}\\007'")
}

#[test]
fn a_hidden_line_leaves_the_pane_exactly_as_it_found_it() {
    let mut s = Session::new(120);
    let before = s.snapshot();

    s.hidden(&probe_payload("__bshook_y__"));

    assert_eq!(s.snapshot(), before, "something was left behind");
}

#[test]
fn width_is_no_longer_something_the_pane_depends_on() {
    // The heart of it. Smoke 56-3 was clean at 120 columns and left most of
    // every hidden line on the screen at 80, because the erase counted rows and
    // a wrapped line occupies two. Nothing is drawn now, so nothing can wrap,
    // and the narrow end of this range is narrower than any pane anybody works
    // in. If this ever fails at one width and passes at another, the curtain
    // has stopped being the thing that hides the plumbing.
    for cols in [40, 60, 80, 100, 120, 200] {
        let mut s = Session::new(cols);
        let before = s.snapshot();
        s.opening_probes();
        s.opening_probes();
        assert_eq!(s.snapshot(), before, "at {cols} columns");
    }
}

#[test]
fn a_prompt_that_takes_two_rows_is_no_harder_than_one_that_takes_one() {
    // What waiting for the prompt's own mark buys. The curtain stays down
    // through the redraw, so the pane keeps the prompt it already had and never
    // has to work out how tall it was. An erase could not have done this at any
    // row count, because the count depends on the prompt.
    let mut s = Session::new(80);
    s.sh.prompt = "\u{250c}\u{2500}[root@skills-host-01]\u{2500}[~]\n\u{2514}\u{2500}# ".into();
    s.pane = Pane::new(80);
    s.pane.feed(BANNER);
    s.pane.feed("\n");
    let p = s.sh.prompt();
    s.pane.feed(&p);
    let before = s.snapshot();

    s.opening_probes();

    assert_eq!(s.snapshot(), before);
}

#[test]
fn the_operator_never_reads_the_engines_own_plumbing() {
    let mut s = Session::new(100);
    s.opening_probes();

    let seen = s.snapshot();
    for plumbing in ["printf", "__bsshell_", "__bshook_", "6273", "stty"] {
        assert!(
            !seen.contains(plumbing),
            "{plumbing:?} was left on the screen:\n{seen}"
        );
    }
}

#[test]
fn the_curtain_does_not_reach_the_output_above_it() {
    // The failure the other way round: hiding that takes one thing too many
    // costs the operator a line of their own host's output.
    let mut s = Session::new(100);
    s.sh.output = "nginx is not installed\n".to_string();
    s.command(" check-something\n");
    s.sh.output.clear();
    let before = s.snapshot();
    assert!(before.contains("nginx is not installed"));

    s.opening_probes();

    assert_eq!(s.snapshot(), before);
}

#[test]
fn three_hidden_lines_and_two_commands_read_like_a_session_nobody_automated() {
    // Smoke test 56-2 section A1, as a test. A run opens with the shell probe
    // and the hook offer, `sudo -i` costs another hook offer because the nested
    // shell has none, and what is left on the glass is the two commands the
    // operator asked for.
    let mut s = Session::new(80);

    s.opening_probes();
    s.command(" sudo -i\n");
    s.hidden(&probe_payload("__bshook_y__"));
    s.command(" test -f /etc/nginx/nginx.conf\n");

    assert_eq!(
        s.snapshot(),
        format!(
            "{BANNER}\n\
             {PROMPT} sudo -i\n\
             {PROMPT} test -f /etc/nginx/nginx.conf\n\
             {}",
            PROMPT.trim_end()
        )
    );
}

#[test]
fn no_command_the_operator_asked_for_appears_twice() {
    // Smoke 56-4 section A2. The double echo came from restoring the terminal's
    // echo with an external binary: the engine typed its next command while the
    // shell was still forking `stty`, so the tty driver echoed it where it
    // landed and the line editor drew it again at the prompt. Nothing is forked
    // any more, and there is no echo to restore, so the shape of that bug is
    // gone. This is the test that would notice it coming back.
    let mut s = Session::new(80);
    s.opening_probes();
    s.command(" sudo -i\n");
    s.command(" whoami\n");

    let seen = s.snapshot();
    for line in ["sudo -i", "whoami"] {
        assert_eq!(
            seen.matches(line).count(),
            1,
            "{line:?} is on the screen more than once:\n{seen}"
        );
    }
}

#[test]
fn a_shell_that_draws_its_own_line_is_hidden_just_the_same() {
    // zsh. Its line editor draws what is being typed itself rather than letting
    // the tty echo it, which is why `stty -echo` never worked there and why zsh
    // used to fall back to the visible completion marker. The curtain does not
    // care who drew the bytes or how many of them there are, so this is now the
    // same case as bash. That is the whole reason zsh gets quiet markers now.
    let mut s = Session::new(80);
    let before = s.snapshot();

    // A line editor's redraw: it rewrites the line as it goes, with cursor
    // moves and a re-print, which is far more bytes than an echo.
    s.curtain.lower(End::PromptMark);
    let payload = probe_payload("__bshook_y__");
    let line = hidden_line(&payload);
    let typed = line.trim_end_matches('\n');
    let redrawn = format!("\r\u{1b}[2K{PROMPT}{typed}\r\u{1b}[2K{PROMPT}{typed}\n");
    s.show(&redrawn);
    let out = {
        let mut sh = Shell::new();
        sh.submit(&line)
    };
    s.show(&out);
    s.curtain.raise();

    assert_eq!(s.snapshot(), before);
}

#[test]
fn a_shell_with_no_marks_at_all_still_gets_a_clean_pane() {
    // A plain `sh`: the integration is POSIX enough to parse and installs
    // nothing, so no prompt mark is ever coming. The curtain lifts at the
    // engine's own answer instead, and the line clears the row on its way out
    // so the prompt that follows lands on it rather than after it.
    let mut s = Session::unhooked(80);
    let before = s.snapshot();

    s.hidden(&probe_payload("__bsshell_-sh__"));

    assert_eq!(s.snapshot(), before);
}

#[test]
fn a_payload_that_prints_is_hidden_with_the_rest_of_the_plumbing() {
    // A deliberate change from the erase design, which let a hidden payload's
    // complaint through on the grounds that it might matter. It does not: the
    // only payload that can print is the hook offer, its complaint is about
    // Broadside's own snippet rather than about anything the operator did, and
    // the run answers it by falling back to the visible marker. Showing them a
    // bash error about `__omni_precmd` is noise.
    let mut s = Session::new(100);
    let before = s.snapshot();

    s.sh.output = "bash: __omni_precmd: command not found\n".to_string();
    s.hidden("some-payload");

    let seen = s.snapshot();
    assert_eq!(seen, before, "the pane is untouched either way:\n{seen}");
}

#[test]
fn a_prompt_still_being_drawn_when_the_curtain_falls_is_not_eaten() {
    // The engine is told the login is over by the shell announcing a prompt,
    // and `OSC 133 ; A` is the announcement, not the prompt: the text and the
    // `B` on the end of it are still to come. Lowering the curtain there drops
    // them, and the run's opening prompt is gone from the pane for good. The
    // engine waits for the prompt to close before it hides anything, and this
    // is the shape of what it is waiting out.
    let mut s = Session::new(80);
    // A prompt part-way onto the screen: announced, nothing drawn yet.
    s.pane.feed("\u{1b}]133;A\u{7}");

    // What the engine does: let it land first, and only then hide.
    s.pane.feed(&s.sh.prompt());
    s.hidden(&probe_payload("__bsshell_-bash__"));

    let seen = s.snapshot();
    assert_eq!(
        seen.matches(PROMPT.trim_end()).count(),
        2,
        "the prompt the operator was owed is missing:\n{seen}"
    );
}

#[test]
fn nothing_the_engine_types_moves_the_cursor() {
    // The old plumbing carried `\033[3A` and an erase-to-end-of-display, and
    // every bug in three builds was that arithmetic. The only escape left is
    // the one that clears the row the cursor is already on. Stated here so that
    // putting a cursor movement back has to argue with a test first.
    let line = hidden_line("printf 'x'");
    assert!(!line.contains("\\033["), "{line:?}");
    assert!(!line.contains("stty"), "{line:?}");
    assert_eq!(line, " printf 'x'\n");

    let repairing = hidden_line_self_repairing("printf 'x'");
    assert!(!repairing.contains("A"), "no cursor-up: {repairing:?}");
    assert!(!repairing.contains("0J"), "no erase-display: {repairing:?}");
    assert!(repairing.contains(r"\r\033[2K"), "{repairing:?}");
}

#[test]
fn the_old_shape_would_still_fail_this_model() {
    // The model has to be able to report a dirty pane, or every test above is
    // vacuous. This is build 56-3's hidden pair fed straight to the pane with
    // no curtain in front of it: clean at 120 columns, which is why it passed
    // everything, and dirty at 80, which is where the smoke test found it.
    let old_first = format!(
        " stty -echo; printf '\\033[1A\\r\\033[0J\\033]{BS_OSC};__bsecho_%s__\\007' \"$?\"\n"
    );
    let old_second = format!(
        " {}; printf '\\033[1A\\r\\033[0J'; stty echo\n",
        probe_payload("__bshook_y__")
    );

    for (cols, dirty) in [(120, false), (80, true)] {
        let mut s = Session::new(cols);
        s.sh.hooked = false;
        let before = s.snapshot();
        // No curtain: straight to the glass, as it was.
        let a = s.sh.submit(&old_first);
        s.pane.feed(&a);
        let b = s.sh.submit(&old_second);
        s.pane.feed(&b);
        assert_eq!(
            s.snapshot().contains("stty"),
            dirty,
            "at {cols} columns the old shape should {} have left something:\n{}",
            if dirty { "" } else { "not" },
            s.snapshot()
        );
        if !dirty {
            assert_eq!(s.snapshot(), before);
        }
    }
}
