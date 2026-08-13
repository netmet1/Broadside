//! What the operator actually sees while the engine types.
//!
//! A hidden line is three commands and an erase, and whether they leave the pane
//! as they found it is arithmetic about rows. Nothing else in these tests can
//! check it: the fake host in [`super::tests`] answers questions, it does not
//! draw, so an erase that takes the wrong rows passes every one of them. That
//! arithmetic has now been wrong three times (smoke tests 56, 56-2 and 56-3), so
//! it gets a terminal of its own here, with a width.
//!
//! Two things in the model are measurements rather than protocol. The first is
//! that submitting a line moves the shell to a new row **whether or not the line
//! was echoed**: smoke 56-2 left exactly one row behind per hidden line, the
//! echoed part, and no other geometry produces that. The second is that a line
//! too long for the pane wraps onto another row and the erase, which counts
//! rows, then leaves the part that wrapped: that is smoke 56-3, at eighty
//! columns, five times over.

use super::{
    echo_report_line, hidden_line, restore_line, screen::BS_OSC, ERASE_HIDDEN, QUIET_LINE,
};

/// The prompt from the smoke test, so a failure here reads like the report.
const PROMPT: &str = "root@skills-host-01:~# ";
const BANNER: &str = "Last login: Wed Aug 12 21:30:32 2026 from 203.0.113.215";

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

/// A shell at a prompt: it echoes what is typed only while the echo is on,
/// always moves to a new row when a line is submitted, runs the line, and draws
/// its prompt again.
struct Shell {
    echo: bool,
    /// Whether `stty -echo` actually stops it echoing. False for a shell whose
    /// line editor draws the line itself and does not consult the terminal,
    /// which is zsh, measured.
    obeys_stty: bool,
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
            obeys_stty: true,
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
        // The measurement, not the protocol: the submission takes a row whether
        // or not the line was echoed. See the module docs.
        pane.feed("\n");
        for seg in segments(typed) {
            self.run(seg.trim(), pane);
        }
        pane.feed(PROMPT);
    }

    fn run(&mut self, seg: &str, pane: &mut Pane) {
        match seg {
            "stty -echo" => self.echo = !self.obeys_stty,
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

/// The three lines of one hidden line, as [`super::Engine::send_hidden`] sends
/// them.
fn hidden_lines(sh: &mut Shell, pane: &mut Pane) {
    sh.submit(QUIET_LINE, pane);
    sh.submit(&echo_report_line(), pane);
    sh.submit(&hidden_line(&probe_payload()), pane);
}

#[test]
fn a_hidden_line_leaves_the_pane_exactly_as_it_found_it() {
    let mut pane = Pane::new(120);
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    let before = pane.snapshot();

    hidden_lines(&mut sh, &mut pane);

    assert_eq!(pane.snapshot(), before, "something was left behind");
    assert!(sh.echo, "the echo has to be back on afterwards");
}

#[test]
fn eighty_columns_is_not_a_narrow_pane() {
    // Smoke 56-3. The erase counts rows, so the only text that can be echoed has
    // to fit on one, and "kept short" has to mean short enough for the width
    // every terminal has by default and roughly what a tile in a four-up grid
    // gets. Eleven characters and a prompt do. Sixty-seven and a prompt did not.
    let mut pane = Pane::new(80);
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    let before = pane.snapshot();

    hidden_lines(&mut sh, &mut pane);
    hidden_lines(&mut sh, &mut pane);

    assert_eq!(pane.snapshot(), before);
}

#[test]
fn the_echoed_line_fits_a_pane_with_room_to_spare() {
    // The margin, said as a number so that anything lengthening this line has to
    // come back here and think about eighty columns.
    let echoed = QUIET_LINE.trim_end_matches('\n').len();
    assert!(
        echoed <= 16,
        "line one is {echoed} characters, and every one of them has to fit on a \
         row with the prompt in front of it"
    );
}

#[test]
fn the_operator_never_reads_the_engines_own_plumbing() {
    let mut pane = Pane::new(100);
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    hidden_lines(&mut sh, &mut pane);

    let seen = pane.snapshot();
    for plumbing in ["stty", "printf", "__bsecho_", "__bshook_", "6273"] {
        assert!(
            !seen.contains(plumbing),
            "{plumbing:?} was left on the screen:\n{seen}"
        );
    }
}

#[test]
fn the_erase_does_not_reach_the_output_above_it() {
    // The failure the other way round: an erase that counts one row too many
    // takes a line of the host's own output with it.
    let mut pane = Pane::new(100);
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    sh.output = "nginx is not installed\n".to_string();
    sh.submit(" check-something\n", &mut pane);
    sh.output.clear();
    let before = pane.snapshot();
    assert!(before.contains("nginx is not installed"));

    hidden_lines(&mut sh, &mut pane);

    assert_eq!(pane.snapshot(), before);
}

#[test]
fn three_hidden_lines_and_two_commands_read_like_a_session_nobody_automated() {
    // Smoke test 56-2 section A1, as a test. A run opens with the shell probe
    // and the hook offer, `sudo -i` costs another hook offer because the nested
    // shell has none, and what is left on the glass is the two commands the
    // operator asked for.
    let mut pane = Pane::new(80);
    let mut sh = Shell::new();
    sh.boot(&mut pane);

    hidden_lines(&mut sh, &mut pane);
    hidden_lines(&mut sh, &mut pane);
    sh.submit(" sudo -i\n", &mut pane);
    hidden_lines(&mut sh, &mut pane);
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
fn a_line_that_wraps_is_what_the_erase_cannot_survive() {
    // Both mistakes in one test, so the model is known to be able to fail and
    // the reason the lines are shaped the way they are is on the record.
    //
    // This is build56-3's hidden pair: the `stty` and its report on one line
    // with the erase on the front, and a payload line that takes back two rows.
    // At 120 columns it is clean, which is why it passed everything. At 80 the
    // echoed line wraps, the erase takes back the rows it counted rather than
    // the rows that were used, and most of it stays on the screen.
    let old_first = format!(
        " stty -echo; printf '\\033[1A\\r\\033[0J\\033]{BS_OSC};__bsecho_%s__\\007' \"$?\"\n"
    );
    let old_second = format!(
        " {}; printf '\\033[1A\\r\\033[0J'; stty echo\n",
        probe_payload()
    );

    for (cols, dirty) in [(120, false), (80, true)] {
        let mut pane = Pane::new(cols);
        let mut sh = Shell::new();
        sh.boot(&mut pane);
        let before = pane.snapshot();
        sh.submit(&old_first, &mut pane);
        sh.submit(&old_second, &mut pane);
        assert_eq!(
            pane.snapshot().contains("stty"),
            dirty,
            "at {cols} columns the old shape should {} have left something:\n{}",
            if dirty { "" } else { "not" },
            pane.snapshot()
        );
        if !dirty {
            assert_eq!(pane.snapshot(), before);
        }
    }
}

#[test]
fn a_shell_that_will_not_go_quiet_still_gets_its_pane_back() {
    // zsh. Its line editor draws what is being typed itself and does not care
    // what `stty` was told, so both of the first two lines are seen and the
    // engine refuses to send the third (the hook offer is most of a screenful).
    // Refusing is right. Leaving the asking on the screen is not, so the line
    // that backs out takes the same four rows with it.
    let mut pane = Pane::new(80);
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    let before = pane.snapshot();

    sh.obeys_stty = false;
    sh.submit(QUIET_LINE, &mut pane);
    sh.submit(&echo_report_line(), &mut pane);
    sh.submit(&restore_line(), &mut pane);

    assert!(sh.echo, "this shell was never going to stop echoing");
    assert_eq!(pane.snapshot(), before);
}

#[test]
fn a_payload_with_a_mouth_on_it_is_heard_rather_than_swallowed() {
    // The erase now runs at the front of the last line rather than the end of
    // it, so a hidden payload that prints something says it where the prompt
    // was about to go, instead of being wiped by its own line's tidying up.
    // Nothing sent this way is supposed to print (they answer inside an escape
    // sequence, and the one that could have complained is redirected at the
    // source), so this is about what happens when something goes wrong: the
    // operator gets to see it, and the pane below it still lines up.
    let mut pane = Pane::new(100);
    let mut sh = Shell::new();
    sh.boot(&mut pane);
    let before = pane.snapshot();

    sh.submit(QUIET_LINE, &mut pane);
    sh.submit(&echo_report_line(), &mut pane);
    sh.output = "bash: __omni_precmd: command not found\n".to_string();
    sh.submit(&hidden_line("some-payload"), &mut pane);

    let seen = pane.snapshot();
    assert!(
        seen.contains("command not found"),
        "the complaint was eaten:\n{seen}"
    );
    assert!(
        !seen.contains("stty"),
        "and none of the asking is left either:\n{seen}"
    );
    assert_eq!(
        seen.lines().count(),
        before.lines().count() + 1,
        "one row for the complaint, and no others:\n{seen}"
    );
}

#[test]
fn the_erase_takes_back_one_row_per_line_submitted_plus_the_one_it_stands_on() {
    // The count, stated where a future edit to the number of lines will trip
    // over it: three lines go out, so the erase is three up and everything below.
    assert_eq!(ERASE_HIDDEN, r"\033[3A\r\033[0J");
}
