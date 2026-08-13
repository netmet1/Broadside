//! What the operator actually sees while the engine types.
//!
//! A hidden line is two commands and two erases, and whether they leave the pane
//! as they found it is arithmetic about rows. Nothing else in these tests can
//! check it: the fake host in [`super::tests`] answers questions, it does not
//! draw, so an erase that takes the wrong rows passes every one of them. That
//! arithmetic has now been wrong twice in a row (smoke tests 56 and 56-2), so it
//! gets a terminal of its own here.
//!
//! The model is deliberately small, and only one thing in it is an assumption
//! rather than a fact of the protocol: that submitting a line moves the shell to
//! a new row **whether or not the line was echoed**. That is measured, not
//! guessed. Smoke 56-2 left exactly one row behind per hidden pair, the echoed
//! first line, and no other geometry produces that: had the unechoed submission
//! stayed on its row, the erase would have reached one row further up and taken
//! the echoed line with it.
//!
//! The modelled pane is wide enough that nothing wraps, which is the documented
//! limit of the erase rather than an oversight.

use super::{hidden_line, quiet_line, screen::BS_OSC};

/// The prompt from the smoke test, so a failure here reads like the report.
const PROMPT: &str = "root@skills-host-01:~# ";
const BANNER: &str = "Last login: Wed Aug 12 21:30:32 2026 from 203.0.113.215";

/// A terminal, in the only dimensions this cares about: rows of text, and where
/// the cursor sits in them.
struct Pane {
    rows: Vec<Vec<char>>,
    row: usize,
    col: usize,
}

impl Pane {
    fn new() -> Self {
        Pane {
            rows: vec![Vec::new()],
            row: 0,
            col: 0,
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
                        let n = num.parse::<usize>().unwrap_or(0).max(1);
                        match action {
                            'A' => self.row = self.row.saturating_sub(n),
                            // Erase in display, from the cursor down. Every use
                            // here is the default (0) form.
                            'J' => self.erase_below(),
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
                '\n' => {
                    self.row += 1;
                    self.col = 0;
                    while self.rows.len() <= self.row {
                        self.rows.push(Vec::new());
                    }
                }
                '\r' => self.col = 0,
                _ => self.put(c),
            }
        }
    }

    fn put(&mut self, c: char) {
        let row = &mut self.rows[self.row];
        while row.len() < self.col {
            row.push(' ');
        }
        if self.col < row.len() {
            row[self.col] = c;
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

/// A shell at a prompt: it echoes what is typed only while the echo is on,
/// always moves to a new row when a line is submitted, runs the line, and draws
/// its prompt again.
struct Shell {
    echo: bool,
    /// What a command that is not `stty` or `printf` prints. The engine's
    /// payloads print an escape sequence and nothing else, which is the point of
    /// them, so this is empty except in the test that asks what happens when it
    /// is not.
    output: String,
}

impl Shell {
    fn new() -> Self {
        Shell {
            echo: true,
            output: String::new(),
        }
    }

    /// A session as the engine finds it: a login banner and a prompt.
    fn boot(&mut self, pane: &mut Pane) {
        pane.feed(BANNER);
        pane.feed("\n");
        pane.feed(PROMPT);
    }

    fn submit(&mut self, line: &str, pane: &mut Pane) {
        let typed = line.trim_end_matches('\n');
        if self.echo {
            pane.feed(typed);
        }
        // The one assumption in the model, and the one the bug turned on: the
        // submission takes a row whether or not the line was echoed. See the
        // module docs.
        pane.feed("\n");
        for seg in segments(typed) {
            self.run(seg.trim(), pane);
        }
        pane.feed(PROMPT);
    }

    fn run(&mut self, seg: &str, pane: &mut Pane) {
        match seg {
            "stty -echo" => self.echo = false,
            "stty echo" => self.echo = true,
            _ if seg.starts_with("printf ") => {
                let out = expand_printf(seg);
                pane.feed(&out);
            }
            _ => {
                let out = self.output.clone();
                pane.feed(&out);
            }
        }
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
    let arg = match parts.next().unwrap_or_default().trim() {
        // `$?` after a `stty` that worked.
        "\"$?\"" => "0",
        other => other.trim_matches('"'),
    };
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
fn probe_payload() -> String {
    format!("printf '\\033]{BS_OSC};__bshook_y__\\007'")
}

fn hidden_pair(sh: &mut Shell, pane: &mut Pane) {
    sh.submit(&quiet_line(), pane);
    sh.submit(&hidden_line(&probe_payload()), pane);
}

#[test]
fn a_hidden_pair_leaves_the_pane_exactly_as_it_found_it() {
    let mut pane = Pane::new();
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    let before = pane.snapshot();

    hidden_pair(&mut sh, &mut pane);

    assert_eq!(pane.snapshot(), before, "the pair left something behind");
    assert!(sh.echo, "the echo has to be back on afterwards");
}

#[test]
fn the_operator_never_reads_the_engines_own_plumbing() {
    let mut pane = Pane::new();
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    hidden_pair(&mut sh, &mut pane);

    let seen = pane.snapshot();
    for plumbing in ["stty", "printf", "__bsecho_", "__bshook_", "6273"] {
        assert!(
            !seen.contains(plumbing),
            "{plumbing:?} was left on the screen:\n{seen}"
        );
    }
}

#[test]
fn the_erase_does_not_reach_the_output_above_the_pair() {
    // The failure the other way round: an erase that counts one row too many
    // takes a line of the host's own output with it.
    let mut pane = Pane::new();
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    sh.output = "nginx is not installed\n".to_string();
    sh.submit(" check-something\n", &mut pane);
    sh.output.clear();
    let before = pane.snapshot();
    assert!(before.contains("nginx is not installed"));

    hidden_pair(&mut sh, &mut pane);

    assert_eq!(pane.snapshot(), before);
}

#[test]
fn three_pairs_and_two_commands_read_like_a_session_nobody_automated() {
    // Smoke test 56-2 section A1, as a test. A run opens with the shell probe
    // and the hook offer, `sudo -i` costs another hook offer because the nested
    // shell has none, and what is left on the glass is the two commands the
    // operator asked for.
    let mut pane = Pane::new();
    let mut sh = Shell::new();
    sh.boot(&mut pane);

    hidden_pair(&mut sh, &mut pane);
    hidden_pair(&mut sh, &mut pane);
    sh.submit(" sudo -i\n", &mut pane);
    hidden_pair(&mut sh, &mut pane);
    sh.submit(" test -f /etc/nginx/nginx.conf\n", &mut pane);

    assert_eq!(
        pane.snapshot(),
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
fn the_first_line_erasing_itself_is_what_makes_the_difference() {
    // What smoke 56-2 saw, reproduced: with the erase only on the second line,
    // the echoed first line is stranded, one row per hidden pair. This is the
    // exact shape of the report, and it is here so the model is known to be able
    // to fail.
    let mut pane = Pane::new();
    let mut sh = Shell::new();
    sh.boot(&mut pane);

    let no_self_erase = quiet_line().replace(super::ERASE_TWO_ROWS, "");
    sh.submit(&no_self_erase, &mut pane);
    sh.submit(&hidden_line(&probe_payload()), &mut pane);

    let seen = pane.snapshot();
    assert!(
        seen.contains("stty -echo"),
        "the model cannot reproduce the bug it is here to catch:\n{seen}"
    );
    assert_eq!(seen.lines().count(), 3, "one stranded row, not more:\n{seen}");
}

#[test]
fn a_payload_with_a_mouth_on_it_strands_a_row() {
    // The constraint the whole scheme rests on, stated as a test rather than
    // left in a comment: the erase takes back a fixed two rows, so a hidden
    // payload that prints a line of its own pushes what is above it out of
    // reach. Everything sent this way answers inside an escape sequence for
    // exactly this reason, and the one payload that could have said something
    // (the hook install, on a shell that chokes on the snippet) is redirected to
    // /dev/null at the source. See `Engine::install_hooks`.
    let mut pane = Pane::new();
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    let before = pane.snapshot();

    sh.submit(&quiet_line(), &mut pane);
    sh.output = "bash: __omni_precmd: command not found\n".to_string();
    sh.submit(&hidden_line("some-payload"), &mut pane);

    assert_ne!(
        pane.snapshot(),
        before,
        "if this ever passes cleanly the erase has become forgiving, and the \
         redirect on the hook install is no longer load-bearing"
    );
}
