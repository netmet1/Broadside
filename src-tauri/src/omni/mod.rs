//! VT stream interpretation for the OmniTerminal aggregate view (D-061).
//!
//! Each live PTY session is a full interactive VT byte stream — cursor moves,
//! colours, prompt redraws, echoed keystrokes. You cannot pour N of those into
//! one pane and get something readable. This module feeds one session's bytes
//! through a [`vte`] parser plus a minimal screen model and emits **completion-
//! delimited command blocks**: OmniTerminal stays quiet while a command runs,
//! then drops the whole block in, in completion order (the Broadcast-tab shape,
//! D-003, but driven through the live shells).
//!
//! Command boundaries come from OSC 133 shell-integration markers (D-061
//! Option B) the session's shell is set up to emit on connect:
//!   - `OSC 133 ; A`            prompt start
//!   - `OSC 133 ; B`            command start (user input begins)
//!   - `OSC 133 ; C`            command output begins
//!   - `OSC 133 ; D [; <exit>]` command finished (optional exit code)
//!
//! Full-screen / redrawing apps (vi, less, htop, top, tmux, watch, …) must NOT
//! be mirrored — their output is screen-painting garbage. Detection is
//! **behaviour-based, never a program-name list** (D-061): the alternate-screen
//! escape every full-screen app emits, plus a heuristic for main-screen
//! redrawers (`watch`, some `top` builds, spinners) that don't use it.

use std::time::Instant;

use serde::Serialize;
use vte::{Params, Parser, Perform};

/// Min cursor-repositioning events before the redraw heuristic can fire — keeps
/// ordinary commands (which emit a few) from being misflagged.
const REDRAW_MIN: u32 = 8;
/// Redraw events must outnumber committed lines by this factor to count as an
/// in-place redrawer rather than normal scrolling output.
const REDRAW_RATIO: usize = 3;

/// Why a block is (or isn't) mirrored as text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Interactivity {
    /// Ordinary command — mirror its output lines.
    #[default]
    Normal,
    /// Switched to the alternate screen (vi, less, htop, tmux, man, …).
    AltScreen,
    /// Heavy in-place redraw on the main screen (watch, some top builds, spinners).
    Redraw,
}

impl Interactivity {
    /// True when the block should show the "interactive — not mirrored" notice
    /// instead of its captured output.
    pub fn is_interactive(&self) -> bool {
        !matches!(self, Interactivity::Normal)
    }
}

/// A completed command, ready to render as one color-tinted block in
/// OmniTerminal.
#[derive(Debug, Clone, Serialize)]
pub struct CommandBlock {
    /// The command text, when known (captured between OSC 133 `B` and `C`).
    pub command: Option<String>,
    /// Committed output lines, plain text (escape sequences stripped). Empty
    /// for interactive blocks — the UI shows the notice instead.
    pub lines: Vec<String>,
    /// Exit status from `OSC 133 ; D ; <code>`, when the shell reported one.
    pub exit_code: Option<i32>,
    /// How long the command ran (output-start to done), in milliseconds.
    pub duration_ms: Option<u64>,
    /// Whether/why this block is interactive (don't mirror its output).
    pub interactivity: Interactivity,
}

/// vte performer + minimal screen model for one session. Builds the current
/// line cell-by-cell so carriage-return overwrites (progress bars) collapse to
/// their final text, accumulates lines into the active command block, and
/// finalises a [`CommandBlock`] on each `OSC 133 ; D`.
#[derive(Default)]
struct Performer {
    /// Current line under construction, one char per cell, so `\r`/`\b`
    /// overwrites land in place rather than appending.
    cells: Vec<char>,
    /// Cursor column within `cells`.
    col: usize,
    /// Between `B` and `C`: echoed keystrokes are the command, not output.
    capturing_cmd: bool,
    /// Captured command text.
    command: String,
    /// Between `C` and `D`: printed text is the command's output.
    in_output: bool,
    /// Committed output lines for the active block.
    lines: Vec<String>,
    /// Interactivity verdict for the active block.
    interactivity: Interactivity,
    /// When the active command's output began (for the duration badge).
    started: Option<Instant>,
    /// Cursor-repositioning / erase events seen during the active block.
    redraws: u32,
    /// Completed blocks, drained by the owning [`OmniParser`].
    out: Vec<CommandBlock>,
}

impl Performer {
    /// Commits the current line into the active block's output (if any) and
    /// resets the line buffer.
    fn commit_line(&mut self) {
        let text: String = self.cells.iter().collect();
        if self.in_output {
            self.lines.push(text.trim_end().to_string());
        }
        self.cells.clear();
        self.col = 0;
    }

    fn on_prompt_start(&mut self) {
        // A fresh prompt means the previous command is over. If output was
        // still open (shell emitted A but not D, or the user hit Ctrl-C),
        // flush what we have so the block isn't lost.
        if self.in_output {
            self.end_output(None);
        }
        self.capturing_cmd = false;
        self.command.clear();
    }

    fn start_cmd_capture(&mut self) {
        self.capturing_cmd = true;
        self.command.clear();
    }

    fn start_output(&mut self) {
        self.capturing_cmd = false;
        self.in_output = true;
        self.cells.clear();
        self.col = 0;
        self.lines.clear();
        self.interactivity = Interactivity::Normal;
        self.started = Some(Instant::now());
        self.redraws = 0;
    }

    fn end_output(&mut self, exit_code: Option<i32>) {
        if !self.cells.is_empty() {
            self.commit_line();
        }
        // Main-screen redrawers that never touched the alternate screen: lots
        // of cursor repositioning, few real lines.
        if self.interactivity == Interactivity::Normal
            && self.redraws >= REDRAW_MIN
            && (self.redraws as usize) > self.lines.len().saturating_mul(REDRAW_RATIO)
        {
            self.interactivity = Interactivity::Redraw;
        }
        let command = {
            let c = self.command.trim();
            (!c.is_empty()).then(|| c.to_string())
        };
        let lines = if self.interactivity.is_interactive() {
            Vec::new()
        } else {
            std::mem::take(&mut self.lines)
        };
        let duration_ms = self.started.take().map(|s| s.elapsed().as_millis() as u64);
        self.out.push(CommandBlock {
            command,
            lines,
            exit_code,
            duration_ms,
            interactivity: self.interactivity.clone(),
        });
        // Reset for the next command.
        self.in_output = false;
        self.cells.clear();
        self.col = 0;
        self.lines.clear();
        self.command.clear();
        self.interactivity = Interactivity::Normal;
        self.redraws = 0;
    }
}

impl Perform for Performer {
    fn print(&mut self, c: char) {
        if self.capturing_cmd {
            self.command.push(c);
            return;
        }
        if self.col < self.cells.len() {
            self.cells[self.col] = c;
        } else {
            while self.cells.len() < self.col {
                self.cells.push(' ');
            }
            self.cells.push(c);
        }
        self.col += 1;
    }

    fn execute(&mut self, byte: u8) {
        if self.capturing_cmd {
            // The command echo ends at OSC C; ignore its control bytes.
            return;
        }
        match byte {
            b'\n' => self.commit_line(),
            b'\r' => self.col = 0,
            0x08 => self.col = self.col.saturating_sub(1), // backspace
            b'\t' => {
                let next = ((self.col / 8) + 1) * 8;
                while self.col < next {
                    self.print(' ');
                }
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.is_empty() || params[0] != b"133".as_slice() {
            return;
        }
        match params.get(1).copied() {
            Some(b"A") => self.on_prompt_start(),
            Some(b"B") => self.start_cmd_capture(),
            Some(b"C") => self.start_output(),
            Some(b"D") => {
                let code = params
                    .get(2)
                    .and_then(|b| std::str::from_utf8(b).ok())
                    .and_then(|s| s.trim().parse::<i32>().ok());
                if self.in_output {
                    self.end_output(code);
                }
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        if !self.in_output {
            return;
        }
        // Private DEC modes: ESC [ ? <n> h|l — the alternate-screen toggle.
        if intermediates.first() == Some(&b'?') {
            let first = params
                .iter()
                .next()
                .and_then(|p| p.first().copied())
                .unwrap_or(0);
            if action == 'h' && matches!(first, 1049 | 47 | 1047) {
                self.interactivity = Interactivity::AltScreen;
            }
            return;
        }
        // Cursor repositioning + screen/line erase feed the redraw heuristic.
        if matches!(action, 'H' | 'f' | 'A' | 'B' | 'd' | 'J' | 'K') {
            self.redraws = self.redraws.saturating_add(1);
        }
    }
}

/// One-time shell setup, sent over the PTY right after the shell opens, that
/// makes the remote shell emit the OSC 133 markers this module parses (D-061
/// Option B). It detects the shell at runtime and installs the right prompt
/// hooks; bash and zsh are fully supported, other shells (POSIX sh / ash / dash
/// / fish) fall through to a no-op and rely on the [`OmniParser::flush`]
/// fallback — so this line is always safe to send to any shell.
///
/// Why it's shaped this way:
/// - One single line (`;`-joined) so it's a single command — the hooks it
///   installs take effect on the *next* prompt, never around this setup line.
/// - Octal escapes (`\033`/`\007`) not `\e` — portable across every `printf`.
/// - PROMPT_COMMAND is **prepended** (not clobbered) and `__omni_precmd` reads
///   `$?` first, so a user's existing PROMPT_COMMAND can't corrupt the exit
///   code we report.
/// - The bash branch's `$'...'`-free / the zsh branch's `$(...)`-deferred forms
///   mean a POSIX shell can *parse* the whole `if/elif/fi` without error even
///   though it executes neither branch.
///
/// Markers: `A` prompt-start, `B` prompt-end, `C` output-start, `D;<exit>` done.
pub const SHELL_INTEGRATION: &str = r#"if [ -n "$BASH_VERSION" ]; then __omni_first=1; __omni_pe=1; __omni_precmd() { local s=$?; [ -n "$__omni_first" ] && __omni_first= || printf '\033]133;D;%s\007' "$s"; __omni_pe=; printf '\033]133;A\007'; }; __omni_preexec() { [ -n "$__omni_pe" ] && return; __omni_pe=1; printf '\033]133;C\007'; }; PROMPT_COMMAND="__omni_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; trap __omni_preexec DEBUG; PS1="$PS1"'\[\033]133;B\007\]'; elif [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook; __omni_precmd() { printf '\033]133;D;%s\007\033]133;A\007' "$?"; }; __omni_preexec() { printf '\033]133;C\007'; }; add-zsh-hook precmd __omni_precmd; add-zsh-hook preexec __omni_preexec; PS1="$PS1%{$(printf '\033]133;B\007')%}"; fi"#;

/// The integration line ready to write to a PTY (newline-terminated, so the
/// remote shell executes it).
pub fn shell_integration_command() -> String {
    format!("{SHELL_INTEGRATION}\n")
}

/// The full one-time setup line sent on PTY connect (D-063, T1): installs the
/// OSC 133 integration, clears the screen, reprints the MOTD, and re-echoes the
/// real captured `Last login:` line — so the terminal looks like a fresh login
/// without the visible setup command. It's a single line, so the integration's
/// preexec guard suppresses any OmniTerminal block for the clear/MOTD/echo.
pub fn shell_setup_command(last_login: Option<&str>) -> String {
    // Leading space so shells with `ignorespace`/`ignoreboth` in HISTCONTROL
    // (the Debian/Ubuntu default) don't record this long line in shell history
    // — otherwise an Up-arrow in the terminal recalls the whole setup line.
    let mut cmd = String::from(" ");
    cmd.push_str(SHELL_INTEGRATION);
    cmd.push_str("; clear; cat /run/motd.dynamic /etc/motd 2>/dev/null");
    if let Some(ll) = last_login {
        // Single-quote the captured line, escaping any single quotes, so any
        // content is shell-safe. `\\n` reaches printf literally as `\n`.
        let safe = ll.replace('\'', r"'\''");
        cmd.push_str("; printf '%s\\n' '");
        cmd.push_str(&safe);
        cmd.push('\'');
    }
    cmd.push('\n');
    cmd
}

/// Extracts the real, terminated `Last login:` line from the initial login
/// banner (T1). Returns None until the line is fully received.
pub fn extract_last_login(banner: &str) -> Option<String> {
    let idx = banner.find("Last login:")?;
    let rest = &banner[idx..];
    let end = rest.find('\n')?; // require a terminated line
    Some(rest[..end].trim().trim_end_matches('\r').to_string())
}

/// One session's VT interpreter. Feed it the raw PTY bytes; collect completed
/// [`CommandBlock`]s.
pub struct OmniParser {
    parser: Parser,
    perf: Performer,
}

impl Default for OmniParser {
    fn default() -> Self {
        Self::new()
    }
}

impl OmniParser {
    pub fn new() -> Self {
        Self {
            parser: Parser::new(),
            perf: Performer::default(),
        }
    }

    /// Feeds raw bytes and returns any blocks that completed within them.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<CommandBlock> {
        // vte 0.13 advances one byte at a time.
        for &b in bytes {
            self.parser.advance(&mut self.perf, b);
        }
        std::mem::take(&mut self.perf.out)
    }

    /// Force-finalises an in-progress block (timeout fallback for shells
    /// without integration, or session close). Returns the flushed block, if
    /// output was open.
    pub fn flush(&mut self) -> Option<CommandBlock> {
        if self.perf.in_output {
            self.perf.end_output(None);
            return self.perf.out.pop();
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds an `OSC 133 ; <args>` sequence (BEL-terminated).
    fn osc(args: &str) -> Vec<u8> {
        let mut v = vec![0x1b, b']'];
        v.extend_from_slice(b"133;");
        v.extend_from_slice(args.as_bytes());
        v.push(0x07);
        v
    }

    /// Feeds a list of byte chunks and returns all completed blocks.
    fn run(chunks: &[&[u8]]) -> Vec<CommandBlock> {
        let mut p = OmniParser::new();
        let mut blocks = Vec::new();
        for c in chunks {
            blocks.extend(p.feed(c));
        }
        blocks
    }

    #[test]
    fn simple_command_block() {
        let blocks = run(&[
            &osc("A"),
            &osc("B"),
            b"uptime",
            &osc("C"),
            b"14:02 up 9 days\r\n",
            &osc("D;0"),
        ]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].command.as_deref(), Some("uptime"));
        assert_eq!(blocks[0].lines, vec!["14:02 up 9 days"]);
        assert_eq!(blocks[0].exit_code, Some(0));
        assert_eq!(blocks[0].interactivity, Interactivity::Normal);
        // A completed command carries a duration (output-start to done).
        assert!(blocks[0].duration_ms.is_some());
    }

    #[test]
    fn nonzero_exit_code_captured() {
        let blocks = run(&[&osc("C"), b"boom\r\n", &osc("D;1")]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].exit_code, Some(1));
    }

    #[test]
    fn exit_code_optional() {
        let blocks = run(&[&osc("C"), b"ok\r\n", &osc("D")]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].exit_code, None);
        assert_eq!(blocks[0].lines, vec!["ok"]);
    }

    #[test]
    fn carriage_return_overwrites_collapse() {
        // A progress bar that rewrites the line in place should commit only the
        // final text.
        let blocks = run(&[
            &osc("C"),
            b"progress 10%\rprogress 100%\r\n",
            &osc("D;0"),
        ]);
        assert_eq!(blocks[0].lines, vec!["progress 100%"]);
    }

    #[test]
    fn multiple_output_lines() {
        let blocks = run(&[&osc("C"), b"a\r\nb\r\nc\r\n", &osc("D;0")]);
        assert_eq!(blocks[0].lines, vec!["a", "b", "c"]);
    }

    #[test]
    fn partial_last_line_committed() {
        // Output with no trailing newline before D still commits the line.
        let blocks = run(&[&osc("C"), b"no newline", &osc("D;0")]);
        assert_eq!(blocks[0].lines, vec!["no newline"]);
    }

    #[test]
    fn alt_screen_marks_interactive_and_drops_output() {
        // vi/less/htop switch to the alternate screen; we must not mirror the
        // screen-painting garbage.
        let mut seq = osc("C");
        seq.extend_from_slice(b"\x1b[?1049h"); // enter alt screen
        seq.extend_from_slice(b"\x1b[2J\x1b[H garbage repaint ");
        seq.extend_from_slice(b"\x1b[?1049l"); // leave alt screen
        let blocks = run(&[&seq, &osc("D;0")]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].interactivity, Interactivity::AltScreen);
        assert!(blocks[0].lines.is_empty());
    }

    #[test]
    fn old_style_alt_screen_47_detected() {
        let mut seq = osc("C");
        seq.extend_from_slice(b"\x1b[?47h painting \x1b[?47l");
        let blocks = run(&[&seq, &osc("D;0")]);
        assert_eq!(blocks[0].interactivity, Interactivity::AltScreen);
    }

    #[test]
    fn redraw_heuristic_flags_main_screen_redrawer() {
        // A `watch`-style app that clears + repositions on the main screen many
        // times with almost no committed lines.
        let mut seq = osc("C");
        for _ in 0..12 {
            seq.extend_from_slice(b"\x1b[H\x1b[2Jstatus\r");
        }
        seq.extend_from_slice(b"\r\n");
        let blocks = run(&[&seq, &osc("D;0")]);
        assert_eq!(blocks[0].interactivity, Interactivity::Redraw);
        assert!(blocks[0].lines.is_empty());
    }

    #[test]
    fn ordinary_output_with_a_few_escapes_stays_normal() {
        // Colourful but normal output (a couple of SGR/erase) must not trip the
        // redraw heuristic.
        let blocks = run(&[
            &osc("C"),
            b"\x1b[32mline one\x1b[0m\r\n\x1b[Kline two\r\n",
            &osc("D;0"),
        ]);
        assert_eq!(blocks[0].interactivity, Interactivity::Normal);
        assert_eq!(blocks[0].lines, vec!["line one", "line two"]);
    }

    #[test]
    fn new_prompt_flushes_dangling_block() {
        // Ctrl-C: output opened, never got a D, then a fresh prompt (A) arrives.
        let blocks = run(&[
            &osc("A"),
            &osc("B"),
            b"sleep 100",
            &osc("C"),
            b"partial output\r\n",
            &osc("A"), // next prompt — flushes the previous block
        ]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].command.as_deref(), Some("sleep 100"));
        assert_eq!(blocks[0].lines, vec!["partial output"]);
        assert_eq!(blocks[0].exit_code, None);
    }

    #[test]
    fn flush_finalises_in_progress_block() {
        let mut p = OmniParser::new();
        assert!(p.feed(&osc("C")).is_empty());
        assert!(p.feed(b"still running\r\n").is_empty());
        let flushed = p.flush().expect("a block should flush");
        assert_eq!(flushed.lines, vec!["still running"]);
        // Nothing left to flush.
        assert!(p.flush().is_none());
    }

    #[test]
    fn no_markers_yields_no_blocks() {
        // Shell without integration: bytes flow but nothing is delimited until
        // a flush (timeout fallback handles those sessions).
        let blocks = run(&[b"random output with no osc 133\r\n"]);
        assert!(blocks.is_empty());
    }

    #[test]
    fn command_with_arguments_captured() {
        let blocks = run(&[
            &osc("B"),
            b"systemctl status nginx",
            &osc("C"),
            b"active (running)\r\n",
            &osc("D;0"),
        ]);
        assert_eq!(
            blocks[0].command.as_deref(),
            Some("systemctl status nginx")
        );
    }

    #[test]
    fn integration_snippet_has_all_markers_and_both_shells() {
        let s = SHELL_INTEGRATION;
        // All four OSC 133 markers are emitted somewhere.
        for m in ["133;A", "133;C", "133;B", "133;D"] {
            assert!(s.contains(m), "integration missing {m}");
        }
        // Both supported shells are branched on, POSIX falls through.
        assert!(s.contains("BASH_VERSION"));
        assert!(s.contains("ZSH_VERSION"));
        assert!(s.contains("PROMPT_COMMAND"));
        assert!(s.contains("add-zsh-hook"));
        // Octal escapes (portable printf), not \e.
        assert!(s.contains(r"\033") && s.contains(r"\007"));
        // Single line so the hooks install around the next prompt, not this one.
        assert!(!s.contains('\n'));
        // PROMPT_COMMAND is prepended, never clobbered.
        assert!(s.contains(r#"PROMPT_COMMAND="__omni_precmd${PROMPT_COMMAND:+"#));
    }

    #[test]
    fn integration_command_is_newline_terminated() {
        let c = shell_integration_command();
        assert!(c.ends_with('\n'));
        assert_eq!(c.trim_end_matches('\n'), SHELL_INTEGRATION);
    }

    #[test]
    fn setup_command_clears_reprints_motd_and_last_login() {
        let c = shell_setup_command(Some("Last login: Mon Jun 15 from 1.2.3.4"));
        assert!(c.starts_with(' ')); // leading space keeps it out of shell history
        assert!(c.contains("133;A")); // integration is in there
        assert!(c.contains("clear; cat /run/motd.dynamic /etc/motd 2>/dev/null"));
        assert!(c.contains("printf '%s\\n' 'Last login: Mon Jun 15 from 1.2.3.4'"));
        assert!(c.ends_with('\n'));
        // Single line so the preexec guard suppresses any OmniTerminal block.
        assert!(!c.trim_end_matches('\n').contains('\n'));
    }

    #[test]
    fn setup_command_without_last_login_omits_printf() {
        let c = shell_setup_command(None);
        assert!(c.contains("clear; cat /run/motd.dynamic"));
        assert!(!c.contains("printf '%s"));
    }

    #[test]
    fn setup_command_escapes_single_quotes() {
        let c = shell_setup_command(Some("it's here"));
        assert!(c.contains(r"'it'\''s here'"));
    }

    #[test]
    fn extract_last_login_needs_a_terminated_line() {
        assert_eq!(extract_last_login(""), None);
        assert_eq!(extract_last_login("Last login: partial"), None); // no newline yet
        assert_eq!(
            extract_last_login("banner\r\nLast login: Mon from 1.2.3.4\r\nuser@host:~$ ")
                .as_deref(),
            Some("Last login: Mon from 1.2.3.4"),
        );
    }
}
