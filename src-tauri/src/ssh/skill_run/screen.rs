//! The ANSI-stripped view of a PTY stream that expect patterns match against.
//!
//! Raw bytes still stream to the live pane untouched (`pty:data`); this is a
//! parallel, display-free interpretation used *only* for matching, so that a
//! program which repaints its screen with colour and carriage returns (a live
//! monitor like `htop` is the motivating case) doesn't defeat a pattern that would
//! obviously match what the operator can plainly see.
//!
//! Semantics are expect's, not a terminal's: output accumulates into a buffer
//! that is **consumed through the end of a match**, so text arriving slightly
//! before a step starts is still matchable (no race) while text already matched
//! never re-matches. Line editing (`\r` overwrite, backspace, erase-line) is
//! applied to the current, unterminated line; once a `\n` terminates a line it
//! is frozen. That collapses in-place redraws to their final text while keeping
//! the buffer append-only and cheap.
//!
//! The current line is part of the match view: an interactive prompt
//! (`Do you want to continue? [Y/n] `) never sends a newline, so a matcher that
//! only saw completed lines could never answer one.
//!
//! ## Marks: the things in the stream that are addressed to us
//!
//! Two kinds of escape sequence carry meaning rather than appearance, and both
//! are invisible to the operator because no terminal draws an OSC:
//!
//! - **OSC 133**, the shell integration [`crate::omni`] installs on connect.
//!   The shell announces its own prompts, where a command's output starts, and
//!   what a command exited with. That is what lets a skill run a command
//!   *plain*, with no completion marker appended for the operator to read.
//! - **OSC 6273**, Broadside's own. The engine's probes print their answer
//!   inside one so the pane never shows it. The payload is put into the match
//!   view as a line of text, so the same pattern matches whether the shell
//!   understood the escape or printed it literally.
//!
//! Marks are *taken*, not matched: a completion that has already been banked
//! must never answer the next command, so the engine arms them before it types.

use vte::{Params, Parser, Perform};

/// Broadside's private OSC number, used for the engine's own probe answers.
///
/// Arbitrary, and picked not to collide with any published one (0-2, 4, 7-9,
/// 10-19, 52, 99, 104, 110-119, 133, 633, 777, 1337). A terminal that does not
/// know an OSC identifier drops the whole sequence, which is exactly what is
/// wanted: the answer reaches the engine and never reaches the glass.
pub const BS_OSC: &str = "6273";

/// What the shell has told us about itself since the marks were last armed.
#[derive(Default)]
struct Marks {
    /// `OSC 133 ; A`: the shell printed a prompt. Proof that its integration
    /// hooks are installed *and* firing in whatever shell is in front of us,
    /// which is the one thing a nested shell (`sudo -i`) takes away.
    prompt: bool,
    /// `OSC 133 ; C`: where in the view the command's output began, which is
    /// everything after the shell's echo of the command line.
    ///
    /// A position rather than a flag, because it cannot be acted on when it
    /// arrives: a command quick enough to finish inside one round trip sends
    /// its echo, this mark, its output and its completion in a single chunk, so
    /// by the time anything looks, the output it is meant to delimit is already
    /// in the buffer behind it. Kept as an offset and applied at the end.
    output_at: Option<usize>,
    /// `OSC 133 ; D ; <code>`: the command finished. The inner `Option` is the
    /// exit status, absent when the shell reported none.
    done: Option<Option<i32>>,
}

/// Frozen-line budget. Long enough to span a verbose step's output, bounded so
/// a run that produces gigabytes can't grow the buffer without limit.
const MAX_PENDING: usize = 256 * 1024;
/// A single line can't grow past this (a program emitting a megabyte with no
/// newline shouldn't cost us a megabyte-wide overwrite scan).
const MAX_LINE: usize = 16 * 1024;
/// Tab stops, for `\t` column advance.
const TAB_WIDTH: usize = 8;

/// Interprets the line-editing subset of VT that affects *what text is on
/// screen*, and ignores everything that only affects how it looks.
#[derive(Default)]
struct Interp {
    /// Completed lines, newline-terminated.
    pending: String,
    /// The current, unterminated line as chars (so cursor columns are char
    /// offsets, not byte offsets).
    line: Vec<char>,
    /// Cursor column within `line`.
    col: usize,
    /// What the shell has said about itself, out of band.
    marks: Marks,
}

impl Interp {
    /// How long the match view is right now, in bytes: what a mark's position
    /// is measured against.
    fn view_len(&self) -> usize {
        self.pending.len() + self.line.iter().map(|c| c.len_utf8()).sum::<usize>()
    }

    fn freeze_line(&mut self) {
        if self.pending.len() + self.line.len() > MAX_PENDING {
            self.trim_pending();
        }
        self.pending.extend(self.line.iter());
        self.pending.push('\n');
        self.line.clear();
        self.col = 0;
    }

    /// Drops the oldest half of the frozen buffer, on a char boundary and
    /// (where possible) at a line break so a pattern never matches across a
    /// severed line.
    fn trim_pending(&mut self) {
        // Get onto a character boundary BEFORE slicing. Slicing a String at a
        // byte that lands inside a character panics, and half of a buffer is
        // mid-character as soon as the output isn't pure ASCII: any box drawing,
        // accented text or emoji will do it. This ran in the engine's task, so
        // the panic took the whole run down silently.
        let mut cut = self.pending.len() / 2;
        while cut < self.pending.len() && !self.pending.is_char_boundary(cut) {
            cut += 1;
        }
        // Prefer to cut at a line break so a pattern can't match across a
        // severed line.
        if let Some(nl) = self.pending[cut..].find('\n') {
            cut += nl + 1;
        }
        self.pending.drain(..cut);
        self.shift_marks(cut);
    }

    /// Moves a mark's position back by the `cut` bytes that just left the front
    /// of the view, and drops it if it was inside them. A command noisy enough
    /// to be trimmed has lost the boundary between its echo and its output,
    /// which is a `match` test reading one extra line, not a wrong answer.
    fn shift_marks(&mut self, cut: usize) {
        self.marks.output_at = self.marks.output_at.and_then(|at| at.checked_sub(cut));
    }

    fn write_char(&mut self, c: char) {
        if self.col >= MAX_LINE {
            return;
        }
        if self.col < self.line.len() {
            self.line[self.col] = c;
        } else {
            // A cursor parked past the end (cursor-forward past written text)
            // pads with spaces rather than silently shifting the text left.
            while self.line.len() < self.col {
                self.line.push(' ');
            }
            self.line.push(c);
        }
        self.col += 1;
    }
}

impl Perform for Interp {
    fn print(&mut self, c: char) {
        self.write_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => self.freeze_line(),
            // Carriage return parks the cursor at column 0; whatever prints
            // next overwrites in place. This is what collapses a progress bar
            // or a repainting status line to its final text.
            b'\r' => self.col = 0,
            0x08 => self.col = self.col.saturating_sub(1),
            b'\t' => {
                let next = (self.col / TAB_WIDTH + 1) * TAB_WIDTH;
                while self.col < next.min(MAX_LINE) {
                    self.write_char(' ');
                }
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, _inter: &[u8], _ignore: bool, action: char) {
        let first = params.iter().next().and_then(|p| p.first().copied());
        let n = first.unwrap_or(0) as usize;
        match action {
            // Erase in line.
            'K' => match n {
                1 => {
                    for i in 0..self.col.min(self.line.len()) {
                        self.line[i] = ' ';
                    }
                }
                2 => {
                    self.line.clear();
                    self.col = 0;
                }
                // 0 (and the default): erase from the cursor to end of line.
                _ => self.line.truncate(self.col.min(self.line.len())),
            },
            // Erase in display. We model a stream, not a grid, so a clear-screen
            // only drops the line being drawn. Frozen lines stay matchable
            // (a program that clears and repaints must not erase the prompt we
            // are waiting to answer).
            'J' => {
                self.line.clear();
                self.col = 0;
            }
            'C' => self.col = self.col.saturating_add(n.max(1)).min(MAX_LINE),
            'D' => self.col = self.col.saturating_sub(n.max(1)),
            // Cursor horizontal absolute / cursor position: 1-based column.
            'G' | '`' => self.col = n.saturating_sub(1).min(MAX_LINE),
            'H' | 'f' => {
                let col = params
                    .iter()
                    .nth(1)
                    .and_then(|p| p.first().copied())
                    .unwrap_or(1) as usize;
                self.col = col.saturating_sub(1).min(MAX_LINE);
            }
            _ => {}
        }
    }

    /// Colour, DCS and charset selection carry no text, so dropping them *is*
    /// the strip. An OSC carries no text either, but two of them carry
    /// *meaning*, and this is where it is read off. See the module docs.
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell: bool) {
        let Some(id) = params.first() else {
            return;
        };
        if *id == b"133".as_slice() {
            match params.get(1).and_then(|kind| kind.first()) {
                Some(b'A') => self.marks.prompt = true,
                Some(b'C') => self.marks.output_at = Some(self.view_len()),
                Some(b'D') => {
                    self.marks.done = Some(
                        params
                            .get(2)
                            .and_then(|code| std::str::from_utf8(code).ok())
                            .and_then(|code| code.trim().parse().ok()),
                    );
                    // The same hook prints the next prompt's marker immediately
                    // after this one, but a caller checking for a live shell
                    // between the two would read "no hooks" for as long as the
                    // second printf takes to arrive. A completion could only
                    // have come from the hooks, so it counts as the same proof.
                    self.marks.prompt = true;
                }
                _ => {}
            }
            return;
        }
        if *id == BS_OSC.as_bytes() {
            // Ours: the payload is an answer to a probe, so it belongs in the
            // text the engine matches on rather than being dropped. Written as
            // its own line, because a `printf` cannot put a newline inside an
            // OSC (the parser ignores one) and a probe's answer reads as a line.
            for (i, part) in params[1..].iter().enumerate() {
                if i > 0 {
                    // vte splits the payload on `;`, so put it back.
                    self.write_char(';');
                }
                for c in String::from_utf8_lossy(part).chars() {
                    self.write_char(c);
                }
            }
            self.freeze_line();
        }
    }
    fn hook(&mut self, _p: &Params, _i: &[u8], _ig: bool, _a: char) {}
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}
    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}
}

/// The matchable view of one PTY session.
#[derive(Default)]
pub struct Screen {
    parser: Parser,
    interp: Interp,
    /// Reused scratch for [`view`](Self::view) so matching a busy stream does
    /// not allocate a fresh buffer per chunk.
    view_buf: String,
}

impl Screen {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        // vte 0.13 advances one byte at a time.
        for &b in bytes {
            self.parser.advance(&mut self.interp, b);
        }
    }

    /// The text a pattern matches against: every frozen line plus the current,
    /// unterminated one.
    pub fn view(&mut self) -> &str {
        self.view_buf.clear();
        self.view_buf.push_str(&self.interp.pending);
        self.view_buf.extend(self.interp.line.iter());
        &self.view_buf
    }

    /// Consumes the view through byte offset `end` (the end of a match) and
    /// returns the consumed text, so the same output can never satisfy a later
    /// step. A match reaching into the current line consumes only through the
    /// match end: a repainting program (htop) keeps several values on one
    /// unterminated line, and consuming the line whole ate the *next* step's
    /// value along with this step's match. The value stayed plainly visible in
    /// the pane, was never reprinted, and the next expect timed out on text
    /// the operator could see.
    pub fn consume_through(&mut self, end: usize) -> String {
        self.interp.shift_marks(end);
        if end <= self.interp.pending.len() {
            let tail = self.interp.pending.split_off(end);
            return std::mem::replace(&mut self.interp.pending, tail);
        }
        let mut out = std::mem::take(&mut self.interp.pending);
        // How far the match reaches into the line, bytes to chars. `end` comes
        // from a regex over the view so it lands on a char boundary; the `>=`
        // still rounds a stray mid-char offset up rather than splitting one.
        let line_bytes = end - out.len();
        let mut bytes = 0usize;
        let mut chars = 0usize;
        for c in &self.interp.line {
            if bytes >= line_bytes {
                break;
            }
            bytes += c.len_utf8();
            chars += 1;
        }
        out.extend(self.interp.line.drain(..chars));
        // The cursor keeps its place relative to the surviving text, so a
        // later `\r` repaint still overwrites from the true start of line.
        self.interp.col = self.interp.col.saturating_sub(chars);
        out
    }

    /// Drops everything buffered. Used when handing back from a manual
    /// takeover: whatever the operator typed and whatever it printed must not
    /// satisfy the next automated match.
    pub fn clear(&mut self) {
        self.interp.pending.clear();
        self.interp.line.clear();
        self.interp.col = 0;
        self.arm_marks();
    }

    /// Takes everything buffered, leaving the view empty, with the offset into
    /// it where the shell said the command's output began.
    ///
    /// A completion has no position in the text the way a pattern match does:
    /// it is the last thing the shell says about a command, so everything up to
    /// it belongs to that command and goes with it.
    pub fn take_view(&mut self) -> (String, Option<usize>) {
        let mut out = std::mem::take(&mut self.interp.pending);
        out.extend(self.interp.line.drain(..));
        self.interp.col = 0;
        let len = out.len();
        let at = self.interp.marks.output_at.take();
        (out, at.filter(|at| *at <= len))
    }

    /// Forgets everything the shell has said about itself, so a completion that
    /// has already been banked cannot answer the command about to be typed.
    /// Armed on every line the engine submits: anything it types invalidates
    /// what it knew, including which shell it was talking to.
    pub fn arm_marks(&mut self) {
        self.interp.marks = Marks::default();
    }

    /// Whether the shell has announced a prompt since the marks were armed.
    /// The engine's proof that the integration hooks are live in the shell in
    /// front of it *now*, rather than in the one it started with.
    pub fn saw_prompt(&self) -> bool {
        self.interp.marks.prompt
    }

    /// Whether the shell has reported a command finishing.
    pub fn saw_done(&self) -> bool {
        self.interp.marks.done.is_some()
    }

    /// Takes the reported completion: `Some(code)` when the shell named an exit
    /// status, `Some(None)` when it reported a finish without one.
    pub fn take_done(&mut self) -> Option<Option<i32>> {
        self.interp.marks.done.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view_of(chunks: &[&[u8]]) -> String {
        let mut s = Screen::new();
        for c in chunks {
            s.feed(c);
        }
        s.view().to_string()
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(view_of(&[b"hello\r\nworld\r\n"]), "hello\nworld\n");
    }

    #[test]
    fn unterminated_line_is_visible() {
        // The whole point: a prompt with no newline must be matchable.
        assert_eq!(
            view_of(&[b"Do you want to continue? [Y/n] "]),
            "Do you want to continue? [Y/n] "
        );
    }

    #[test]
    fn colour_is_stripped() {
        assert_eq!(
            view_of(&[b"\x1b[1;32mReady\x1b[0m\r\n"]),
            "Ready\n"
        );
    }

    #[test]
    fn carriage_return_redraw_collapses_to_final_text() {
        // The htop case: one line repainted in place.
        assert_eq!(
            view_of(&[b"Attempt 1: waiting\rAttempt 2: waiting\rAttempt 3: Ready  \r\n"]),
            "Attempt 3: Ready  \n"
        );
    }

    #[test]
    fn erase_to_end_of_line_truncates_stale_text() {
        // Repaint a shorter string over a longer one: without EL handling the
        // tail of the old text would linger and break a `$`-anchored pattern.
        assert_eq!(view_of(&[b"Attempt 10: working\rReady\x1b[K\r\n"]), "Ready\n");
    }

    #[test]
    fn backspace_moves_the_cursor_without_erasing() {
        // Real terminal semantics: BS only moves left, the character stays put
        // until something overwrites it. Anything that means to erase sends the
        // "\x08 \x08" dance, which lands as an overwriting space.
        assert_eq!(view_of(&[b"yess\x08"]), "yess");
        assert_eq!(view_of(&[b"yess\x08 \x08"]), "yes ");
    }

    #[test]
    fn osc_133_markers_are_stripped() {
        // pty.rs injects shell integration into every session; it must not
        // appear in the match view.
        assert_eq!(
            view_of(&[b"\x1b]133;A\x07uptime\x1b]133;C\x07ok\r\n"]),
            "uptimeok\n"
        );
    }

    #[test]
    fn osc_133_reports_a_completion_with_its_exit_code() {
        // The whole point of the quiet path: the shell says how the command
        // ended, and nothing about it is drawn for the operator.
        let mut s = Screen::new();
        s.feed(b" uptime\r\n\x1b]133;C\x07oops\r\n\x1b]133;D;3\x07\x1b]133;A\x07");
        assert_eq!(s.take_done(), Some(Some(3)));
        assert!(s.saw_prompt());
        // Taken once. A banked completion answering the *next* command is the
        // failure this guards against.
        assert_eq!(s.take_done(), None);
        // The whole command comes out, with the boundary between the shell's
        // echo of it and what it printed.
        let (consumed, at) = s.take_view();
        assert_eq!(consumed, " uptime\noops\n");
        assert_eq!(&consumed[at.unwrap()..], "oops\n");
        assert_eq!(s.view(), "");
    }

    #[test]
    fn the_output_boundary_survives_a_command_arriving_all_at_once() {
        // A command quick enough to finish inside one round trip sends its echo,
        // its output and both marks in a single chunk. Acting on the boundary
        // when it arrived would consume the output it is there to delimit; it is
        // a position for exactly this reason.
        let mut s = Screen::new();
        s.feed(b" grep error log\r\n\x1b]133;C\x07nothing here\r\n\x1b]133;D;1\x07");
        let (consumed, at) = s.take_view();
        assert_eq!(&consumed[at.unwrap()..], "nothing here\n");
    }

    #[test]
    fn a_completion_without_a_code_still_counts_as_one() {
        let mut s = Screen::new();
        s.feed(b"\x1b]133;D\x07");
        assert_eq!(s.take_done(), Some(None));
    }

    #[test]
    fn arming_forgets_what_the_shell_said_but_keeps_what_it_printed() {
        let mut s = Screen::new();
        s.feed(b"output\r\n\x1b]133;D;0\x07\x1b]133;A\x07");
        s.arm_marks();
        assert!(!s.saw_done());
        assert!(!s.saw_prompt());
        assert_eq!(s.view(), "output\n", "text is not a mark");
    }

    #[test]
    fn our_own_osc_answers_a_probe_without_printing_it() {
        // The probe's answer is matchable text, and the pane never sees it.
        let mut s = Screen::new();
        s.feed(b"\x1b]6273;__bsuid_0__\x07");
        assert_eq!(s.view(), "__bsuid_0__\n");
    }

    #[test]
    fn a_probe_a_shell_printed_literally_still_matches() {
        // A shell whose printf left the escape alone prints the payload as
        // plain text. Same answer, same pattern, just visible: the probes carry
        // their own marker text so this degrades instead of breaking.
        let mut s = Screen::new();
        s.feed(b"\\033]6273;__bsuid_0__\\007\r\n");
        assert!(s.view().contains("__bsuid_0__"));
    }

    #[test]
    fn escape_split_across_chunks_still_strips() {
        // vte is a streaming parser; a sequence torn across two reads must not
        // leak its bytes into the view.
        assert_eq!(view_of(&[b"\x1b[1;3", b"2mReady\x1b[0m\r\n"]), "Ready\n");
    }

    #[test]
    fn clear_screen_keeps_frozen_lines() {
        // A repainting program must not erase a prompt we're waiting on.
        assert_eq!(view_of(&[b"important\r\ngarbage\x1b[2J"]), "important\n");
    }

    #[test]
    fn cursor_forward_pads_rather_than_shifting() {
        assert_eq!(view_of(&[b"ab\rX\x1b[2CY"]), "Xb Y");
    }

    #[test]
    fn tab_advances_to_next_stop() {
        assert_eq!(view_of(&[b"ab\tc"]), "ab      c");
    }

    #[test]
    fn consume_through_drains_matched_text_only() {
        let mut s = Screen::new();
        s.feed(b"noise\r\nPASSWORD:");
        let end = s.view().find("PASSWORD:").unwrap() + "PASSWORD:".len();
        let eaten = s.consume_through(end);
        assert_eq!(eaten, "noise\nPASSWORD:");
        assert_eq!(s.view(), "");
        // Later output still accumulates normally.
        s.feed(b" ok\r\n");
        assert_eq!(s.view(), " ok\n");
    }

    #[test]
    fn consume_keeps_text_after_the_match() {
        let mut s = Screen::new();
        s.feed(b"first\r\nsecond\r\n");
        let end = s.view().find("first\n").unwrap() + "first\n".len();
        assert_eq!(s.consume_through(end), "first\n");
        assert_eq!(s.view(), "second\n");
    }

    #[test]
    fn consume_mid_line_keeps_the_rest_of_the_line_matchable() {
        // The two-values bug: two step values sharing one unterminated line. The
        // first match must not eat the second value.
        let mut s = Screen::new();
        s.feed(b"web: ok  db: ok");
        let end = s.view().find("web: ok").unwrap() + "web: ok".len();
        assert_eq!(s.consume_through(end), "web: ok");
        assert_eq!(s.view(), "  db: ok");
    }

    #[test]
    fn consume_mid_line_survives_multibyte_text() {
        let mut s = Screen::new();
        s.feed("état: ✓  suivant: ✓".as_bytes());
        let end = s.view().find('\u{2713}').unwrap() + "✓".len();
        let eaten = s.consume_through(end);
        assert_eq!(eaten, "état: ✓");
        assert_eq!(s.view(), "  suivant: ✓");
    }

    #[test]
    fn repaint_after_a_mid_line_consume_overwrites_from_line_start() {
        // After a partial consume, a `\r` repaint must land at the true start
        // of the surviving text, not at a stale cursor offset.
        let mut s = Screen::new();
        s.feed(b"web: ok  db: ....");
        let end = s.view().find("web: ok").unwrap() + "web: ok".len();
        s.consume_through(end);
        s.feed(b"\rweb: ok  db: ok");
        assert_eq!(s.view(), "web: ok  db: ok");
    }

    #[test]
    fn text_arriving_before_a_step_is_not_lost() {
        // The race the consume-on-match model exists to kill: the prompt lands
        // while the previous step is still finishing, and the expect step that
        // answers it starts afterwards. It must still match.
        let mut s = Screen::new();
        s.feed(b"join now? (y/n) ");
        assert!(s.view().contains("join now?"));
    }

    #[test]
    fn clear_drops_operator_takeover_noise() {
        let mut s = Screen::new();
        s.feed(b"operator typed this\r\n");
        s.clear();
        assert_eq!(s.view(), "");
    }

    #[test]
    fn pending_buffer_is_bounded() {
        let mut s = Screen::new();
        for _ in 0..20_000 {
            s.feed(b"a line of noise that repeats forever\r\n");
        }
        assert!(s.view().len() <= MAX_PENDING + MAX_LINE);
    }

    #[test]
    fn trim_pending_never_slices_mid_character() {
        // Trimming cut at len()/2 and sliced there, which panics the moment that
        // offset lands inside a character. Driven straight at the trim because
        // whether a *run* hits it depends on how its line lengths happen to add
        // up, and "usually fine" is the worst kind of bug here: a panicked
        // engine task never reports done and never cleans up its registry
        // entry, so the pane freezes on its last state with every control
        // erroring and only an app restart clears it.
        //
        // 3 x "é" is 6 bytes, so the midpoint is byte 3, inside the second one.
        let mut i = Interp {
            pending: "é".repeat(3),
            ..Default::default()
        };
        i.trim_pending();
        assert!(i.pending.chars().count() <= 3);

        // A few more alignments across 1-, 2-, 3- and 4-byte characters.
        for text in ["ééé", "───", "🙂🙂🙂", "a─b─c─", "é─🙂"] {
            for n in 1..12 {
                let mut i = Interp {
                    pending: text.repeat(n),
                    ..Default::default()
                };
                i.trim_pending();
                // The survivor is still valid UTF-8 and a suffix of the input.
                assert!(text.repeat(n).ends_with(&i.pending), "{text} x{n}");
            }
        }
    }

    #[test]
    fn trimming_keeps_the_view_valid_utf8_and_matchable() {
        let mut s = Screen::new();
        for _ in 0..20_000 {
            s.feed("café ☕ warming up\r\n".as_bytes());
        }
        s.feed("READY\r\n".as_bytes());
        // The tail survives intact and is still matchable after a trim.
        assert!(s.view().contains("READY"));
    }

    #[test]
    fn runaway_line_without_newline_is_bounded() {
        let mut s = Screen::new();
        for _ in 0..10_000 {
            s.feed(b"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        }
        assert!(s.view().len() <= MAX_LINE);
    }
}
