//! Sudo password auto-fill for interactive PTY sessions (D-065 — reverses the
//! PTY exemption stated in D-026).
//!
//! The [`SudoInjector`] is a pure state machine that watches the bytes the
//! operator (or PTY Broadcast) types and the bytes the remote shell emits, and
//! answers a sudo password prompt with the host's stored sudo password. It
//! injects **once per prompt** and stops after a rejection (`Sorry, try
//! again.`), handing control back to the operator — this is the "inject once,
//! then hand off" rule (avoids burning sudo's retry limit / PAM faillock).
//!
//! Detection is hybrid:
//!   * **Tier A** — the sudo-specific `[sudo] password for <user>:` prompt
//!     injects regardless of what was typed (catches history-recalled sudo,
//!     where the keystrokes are just arrow keys).
//!   * **Tier B** — a generic `…password:` prompt injects only when a
//!     `sudo`/`doas` command was just submitted (armed), and never when the
//!     candidate line is the command echo (so a command like
//!     `sudo x # password:` can't trick us into typing the password as a
//!     command).
//!
//! The password lives only here in the backend; it is never echoed to the UI
//! nor placed in the remote argv (D-026 no-leak rule).

use crate::guard;

/// Remote output kept for prompt matching. A sudo prompt is short and arrives
/// at the tail; 512 bytes spans any reasonable chunk boundary.
const TAIL_CAP: usize = 512;
/// Cap on the accumulated input line so a session that never sends a newline
/// (e.g. a full-screen app swallowing keystrokes) can't grow unbounded.
const INPUT_CAP: usize = 4096;
/// A real password prompt line is short. Anything longer is treated as command
/// output, not a prompt — a guard for the generic (Tier B) match.
const MAX_PROMPT_LEN: usize = 64;

/// Watches one PTY session's input/output and answers sudo password prompts.
/// Inert when constructed with `None` (root host, or no stored sudo password).
pub struct SudoInjector {
    password: Option<String>,
    /// A sudo/doas command was just submitted — Tier B may answer the prompt.
    armed: bool,
    /// A rejection was seen; stop injecting until the next sudo command.
    suppressed: bool,
    /// We injected during the current sudo cycle — so a following rejection is
    /// *our* password being wrong (not the operator's own typing).
    did_inject: bool,
    /// Latched when an injected password was rejected; drained by
    /// [`take_rejected`](Self::take_rejected) so the caller can warn once.
    rejected: bool,
    /// The last command submitted while armed, to recognise (and skip) its
    /// echo so we never type the password as a command (Tier B safety).
    armed_cmd: String,
    input_line: Vec<u8>,
    out_tail: String,
}

impl SudoInjector {
    pub fn new(password: Option<String>) -> Self {
        Self {
            password,
            armed: false,
            suppressed: false,
            did_inject: false,
            rejected: false,
            armed_cmd: String::new(),
            input_line: Vec::new(),
            out_tail: String::new(),
        }
    }

    /// Returns (and clears) whether an *injected* password was just rejected —
    /// the caller uses this to warn the operator "possible wrong sudo password"
    /// once per rejection. Never set for the operator's own mistyped password.
    pub fn take_rejected(&mut self) -> bool {
        std::mem::take(&mut self.rejected)
    }

    /// Feed bytes the operator / PTY Broadcast typed. Updates the arm state on
    /// each completed line (Enter is `\r` interactively, `\n` from broadcast).
    pub fn on_input(&mut self, data: &[u8]) {
        if self.password.is_none() {
            return;
        }
        for &b in data {
            if b == b'\r' || b == b'\n' {
                self.submit_line();
            } else if self.input_line.len() < INPUT_CAP {
                self.input_line.push(b);
            }
        }
    }

    fn submit_line(&mut self) {
        let line = String::from_utf8_lossy(&self.input_line).trim().to_string();
        self.input_line.clear();
        if line.is_empty() {
            return;
        }
        // Stale prompt text from a prior command must not satisfy the next
        // match.
        self.out_tail.clear();
        if guard::rewrite_for_sudo(&line).needs_password {
            self.armed = true;
            self.suppressed = false;
            self.did_inject = false; // fresh cycle for the new sudo command
            self.armed_cmd = line;
        } else {
            // A non-sudo command: stop expecting a generic password prompt.
            // (Tier A still self-arms on the `[sudo]` prompt.)
            self.armed = false;
            self.armed_cmd.clear();
        }
    }

    /// Feed remote output bytes. Returns the payload to write back to the
    /// channel (the password + newline) when a sudo prompt should be answered,
    /// or `None`.
    pub fn on_output(&mut self, data: &[u8]) -> Option<String> {
        let password = self.password.clone()?;
        self.out_tail.push_str(&String::from_utf8_lossy(data));
        self.trim_tail();

        let lower = self.out_tail.to_ascii_lowercase();
        // Rejection → hand off; don't inject again until a new sudo command
        // re-arms us.
        if lower.contains("sorry, try again") || lower.contains("incorrect password") {
            // Only warn when it was *our* injected password that bounced.
            if self.did_inject {
                self.rejected = true;
            }
            self.did_inject = false;
            self.suppressed = true;
            self.armed = false;
            self.out_tail.clear();
            return None;
        }
        if self.suppressed {
            return None;
        }

        let trimmed = self.out_tail.trim_end();
        if !trimmed.ends_with(':') {
            return None; // prompt not fully printed yet
        }
        let last_line = trimmed.rsplit(['\n', '\r']).next().unwrap_or(trimmed).trim();
        let last_lower = last_line.to_ascii_lowercase();

        // Tier A: the unambiguous sudo prompt — inject regardless of arming.
        let tier_a = last_line.contains("[sudo] password for ");
        // Tier B: a generic password prompt, but only when armed, short enough
        // to be a prompt (not output), and not the echo of the command itself.
        let is_echo = !self.armed_cmd.is_empty() && last_line.contains(&self.armed_cmd);
        let tier_b = self.armed
            && !is_echo
            && last_line.len() <= MAX_PROMPT_LEN
            && last_lower.contains("password");

        if tier_a || tier_b {
            self.armed = false;
            self.did_inject = true;
            self.out_tail.clear();
            return Some(format!("{password}\n"));
        }
        None
    }

    /// Keep only the last `TAIL_CAP` bytes of the output tail, on a char
    /// boundary.
    fn trim_tail(&mut self) {
        if self.out_tail.len() <= TAIL_CAP {
            return;
        }
        let mut cut = self.out_tail.len() - TAIL_CAP;
        while cut < self.out_tail.len() && !self.out_tail.is_char_boundary(cut) {
            cut += 1;
        }
        self.out_tail = self.out_tail.split_off(cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &str = "hunter2";

    fn armed_injector() -> SudoInjector {
        SudoInjector::new(Some(PW.to_string()))
    }

    #[test]
    fn inert_without_password() {
        let mut s = SudoInjector::new(None);
        s.on_input(b"sudo whoami\n");
        assert_eq!(s.on_output(b"[sudo] password for joe: "), None);
    }

    #[test]
    fn tier_a_injects_on_sudo_prompt() {
        let mut s = armed_injector();
        s.on_input(b"sudo whoami\n");
        assert_eq!(
            s.on_output(b"[sudo] password for joe: "),
            Some(format!("{PW}\n"))
        );
    }

    #[test]
    fn tier_a_injects_even_without_input_arming() {
        // History-recalled sudo: keystrokes are arrow keys, never "sudo".
        let mut s = armed_injector();
        s.on_input(b"\x1b[A\r"); // Up then Enter
        assert_eq!(
            s.on_output(b"[sudo] password for joe: "),
            Some(format!("{PW}\n"))
        );
    }

    #[test]
    fn prompt_split_across_chunks() {
        let mut s = armed_injector();
        s.on_input(b"sudo id\n");
        assert_eq!(s.on_output(b"[sudo] password for joe"), None); // no colon yet
        assert_eq!(s.on_output(b": "), Some(format!("{PW}\n")));
    }

    #[test]
    fn tier_b_generic_prompt_only_when_armed() {
        let mut s = armed_injector();
        // Not armed (no sudo typed): a bare "Password:" must NOT be answered
        // (could be ssh/su/mysql).
        s.on_input(b"ssh other-host\n");
        assert_eq!(s.on_output(b"Password: "), None);

        // Armed: a custom sudo prompt without "[sudo]" is answered.
        let mut s = armed_injector();
        s.on_input(b"sudo -p 'Password: ' whoami\n");
        assert_eq!(s.on_output(b"Password: "), Some(format!("{PW}\n")));
    }

    #[test]
    fn does_not_type_password_into_command_echo() {
        // A command whose echo ends in "password:" must not trick Tier B into
        // typing the password as a shell command.
        let mut s = armed_injector();
        s.on_input(b"sudo cat /etc/shadow # password:\n");
        // sudo creds cached → no prompt, only the echo comes back.
        assert_eq!(s.on_output(b"sudo cat /etc/shadow # password:"), None);
    }

    #[test]
    fn inject_once_then_hand_off_on_rejection() {
        let mut s = armed_injector();
        s.on_input(b"sudo whoami\n");
        assert_eq!(
            s.on_output(b"[sudo] password for joe: "),
            Some(format!("{PW}\n"))
        );
        // Wrong password → sudo prints "Sorry, try again." and re-prompts. We
        // must NOT inject again.
        assert_eq!(
            s.on_output(b"\r\nSorry, try again.\r\n[sudo] password for joe: "),
            None
        );
        // …and the rejection is flagged once so the UI can warn.
        assert!(s.take_rejected());
        assert!(!s.take_rejected()); // drained
        // Even a fresh prompt chunk stays suppressed until re-armed.
        assert_eq!(s.on_output(b"[sudo] password for joe: "), None);
    }

    #[test]
    fn operator_typed_wrong_password_is_not_flagged_as_our_rejection() {
        // No sudo command armed + no injection: a "Sorry, try again." from the
        // operator fumbling their own password must NOT raise our warning.
        let mut s = armed_injector();
        s.on_input(b"ls\n");
        assert_eq!(s.on_output(b"\r\nSorry, try again.\r\n"), None);
        assert!(!s.take_rejected());
    }

    #[test]
    fn re_arms_for_a_new_command_after_success() {
        let mut s = armed_injector();
        s.on_input(b"sudo whoami\n");
        assert_eq!(
            s.on_output(b"[sudo] password for joe: "),
            Some(format!("{PW}\n"))
        );
        // Success: command output flows, no re-prompt.
        assert_eq!(s.on_output(b"\r\nroot\r\njoe@host:~$ "), None);
        // Later, a new sudo command (timestamp expired) prompts again → inject.
        s.on_input(b"sudo reboot\n");
        assert_eq!(
            s.on_output(b"[sudo] password for joe: "),
            Some(format!("{PW}\n"))
        );
    }

    #[test]
    fn broadcast_newline_arms_the_same_way() {
        // PTY Broadcast writes the whole "cmd\n" in one call.
        let mut s = armed_injector();
        s.on_input(b"sudo -k; sudo systemctl restart nginx\n");
        assert_eq!(
            s.on_output(b"[sudo] password for joe: "),
            Some(format!("{PW}\n"))
        );
    }

    #[test]
    fn no_inject_on_ordinary_output() {
        let mut s = armed_injector();
        s.on_input(b"ls -la\n");
        assert_eq!(s.on_output(b"total 8\r\ndrwxr-xr-x  2 joe joe\r\n"), None);
    }

    #[test]
    fn long_password_line_is_not_a_prompt() {
        // A line that mentions "password:" but is long is command output.
        let mut s = armed_injector();
        s.on_input(b"sudo grep secret /etc/app\n");
        let long = b"db_admin_password: correct-horse-battery-staple-extra-long-value-here:";
        assert_eq!(s.on_output(long), None);
    }
}
