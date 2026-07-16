//! The ANSI-stripped view of a PTY stream that expect patterns match against.
//!
//! Raw bytes still stream to the live pane untouched (`pty:data`); this is a
//! parallel, display-free interpretation used *only* for matching, so that a
//! program which repaints its screen with colour and carriage returns (the
//! `cpilot` monitor is the motivating case) doesn't defeat a pattern that would
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
//! (`start the validator(s)? (y/n) `) never sends a newline, so a matcher that
//! only saw completed lines could never answer one.

use vte::{Params, Parser, Perform};

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
}

impl Interp {
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

    // Colour, OSC (including the OSC 133 shell-integration markers pty.rs
    // injects), DCS and charset selection carry no text, so dropping them *is*
    // the strip.
    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell: bool) {}
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
    /// step. A match reaching into the current line consumes that line whole:
    /// the cursor state of a half-eaten line is not worth modelling, and the
    /// line in question has just been answered anyway.
    pub fn consume_through(&mut self, end: usize) -> String {
        if end <= self.interp.pending.len() {
            let tail = self.interp.pending.split_off(end);
            return std::mem::replace(&mut self.interp.pending, tail);
        }
        let mut out = std::mem::take(&mut self.interp.pending);
        out.extend(self.interp.line.iter());
        self.interp.line.clear();
        self.interp.col = 0;
        out
    }

    /// Drops everything buffered. Used when handing back from a manual
    /// takeover: whatever the operator typed and whatever it printed must not
    /// satisfy the next automated match.
    pub fn clear(&mut self) {
        self.interp.pending.clear();
        self.interp.line.clear();
        self.interp.col = 0;
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
            view_of(&[b"start the validator(s)? (y/n) "]),
            "start the validator(s)? (y/n) "
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
        // The cpilot case: one line repainted in place.
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
