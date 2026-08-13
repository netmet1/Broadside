//! What the operator is not shown.
//!
//! The engine has to ask the shell questions (are you bash, are you root, do
//! you have the hooks), and the answers are its own bookkeeping rather than
//! anything the operator asked for. Those lines used to be hidden *at the
//! host*: turn the terminal's echo off with `stty`, type the line, then print a
//! cursor-up-and-erase to take back the rows the plumbing had used.
//!
//! That approach put the plumbing on the glass and removed it a round trip
//! later, which is a blink the operator can see, and it made the pane's
//! correctness a piece of row arithmetic that had to come out right on every
//! pane width, every prompt, and every shell. It did not: three builds' worth
//! of bugs lived in that arithmetic and none of them were in the protocol.
//!
//! The bytes reach the pane through [`SkillTap`](super::SkillTap), which is
//! ours. So the plumbing is hidden **here** instead, by not forwarding it. A
//! line that was never drawn cannot blink, cannot wrap, and cannot leave a
//! fragment at any width.
//!
//! ## Where the curtain comes down, and where it goes back up
//!
//! Down: the instant before the engine types, which it does under the same lock
//! the tap filters under, so nothing can slip past between the two.
//!
//! Up: at a marker in the stream, never at a byte count and never at a timer if
//! a marker is available. There are two, and which one is used decides how good
//! the result is:
//!
//! - [`End::PromptMark`], for a shell running the OSC 133 integration. The
//!   integration puts `OSC 133 ; B` on the end of `PS1`, so that sequence means
//!   "the prompt has finished drawing and input starts here". Dropping
//!   everything up to and including it drops the echo, the newline, the answer,
//!   the shell's own C/D/A marks **and the redrawn prompt**, which leaves the
//!   pane holding the prompt it already had. The pane is then byte-for-byte
//!   what it was before the engine typed: no repair needed, no assumption made
//!   about how many rows a prompt takes, so a two-line `PS1` works like a
//!   one-line one.
//!
//! - [`End::ProbeAnswer`], for a shell that will never send that mark (a plain
//!   `sh`: the integration is POSIX enough to parse there and installs
//!   nothing). The curtain lifts at the end of the engine's own answer, and the
//!   plumbing line carries a `\r` and an erase-line after it so the prompt that
//!   follows is drawn over the old one. That does assume the prompt occupies a
//!   single row, which is the one assumption left in the whole mechanism and is
//!   confined to shells that cannot run a skill quietly anyway.
//!
//! Both are backed by a deadline in the engine, because a curtain that stays
//! down is a frozen pane. See [`Curtain::raise`].
//!
//! ## What this costs
//!
//! Output that a *different* program writes while the curtain is down is
//! dropped with everything else. That is real, and it is strictly less than the
//! old erase destroyed: a cursor-up-and-erase takes back whatever is on those
//! rows no matter who put it there, while this is bounded by one round trip.

use std::sync::{Arc, Mutex};

/// `OSC 133 ; B`, the end of the prompt. Eight bytes, terminated with BEL
/// because that is what [`crate::omni::SHELL_INTEGRATION`] emits.
const PROMPT_MARK: &[u8] = b"\x1b]133;B\x07";

/// The opening of Broadside's own OSC. The answer runs to the next BEL.
const PROBE_OPEN: &[u8] = b"\x1b]6273;";

/// BEL, which terminates every OSC either end of this module writes or reads.
const BEL: u8 = 0x07;

/// A ceiling on what is carried between chunks, so a host that opens an OSC and
/// never terminates it cannot grow this without bound. Generous next to the
/// longest answer the engine ever asks for, which is a shell name.
const MAX_CARRY: usize = 4096;

/// What lifts the curtain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    /// The shell's own end-of-prompt mark, after the engine's answer. Leaves
    /// the pane exactly as it was.
    PromptMark,
    /// The end of the engine's probe answer, for a shell that sends no marks.
    /// The plumbing line repairs the row itself; see the module docs.
    ProbeAnswer,
}

#[derive(Default)]
struct State {
    /// `None` when the operator is seeing everything, which is nearly always.
    down: Option<End>,
    /// Whether the engine's own answer has gone past yet.
    ///
    /// The reason this is not just a mode: everything the shell says arrives a
    /// round trip after the engine typed, so a prompt mark can be in flight
    /// from *before* the line went out. zsh makes the same point from the other
    /// direction, since its line editor redraws the prompt while a line is
    /// being typed at it and every redraw emits the mark again. Either would
    /// lift the curtain on a prompt that has nothing to do with the line being
    /// hidden. The engine's answer is printed by the hidden line itself, so a
    /// mark behind it is the right one and a mark in front of it is somebody
    /// else's. This is the same rule the rest of the engine follows: a fact
    /// only counts once the shell has said the thing it is about had started.
    answered: bool,
    /// Trailing bytes of the last chunk, so a marker split across two reads is
    /// still found. Only kept while the curtain is down.
    carry: Vec<u8>,
}

/// The shared handle. The tap filters through it, the engine raises and lowers
/// it, and the lock is what orders those against each other.
#[derive(Clone, Default)]
pub struct Curtain {
    state: Arc<Mutex<State>>,
}

impl Curtain {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stops forwarding. Called immediately before the engine types, under the
    /// same lock the tap filters under: a chunk that arrives between the two
    /// cannot be forwarded after the decision to hide was taken.
    pub fn lower(&self, end: End) {
        let mut state = self.lock();
        state.down = Some(end);
        state.answered = false;
        state.carry.clear();
    }

    /// Starts forwarding again, whether or not a marker was ever seen.
    ///
    /// The engine calls this when it has its answer and has given the shell a
    /// moment to redraw. It is the backstop that makes a missing marker a
    /// cosmetic problem rather than a pane that never updates again: a shell
    /// that refuses the hooks sends no `B`, and a shell that died sends
    /// nothing at all.
    ///
    /// Returns true when the curtain was still down, meaning no marker
    /// arrived and the caller should repair the row itself.
    pub fn raise(&self) -> bool {
        let mut state = self.lock();
        state.carry.clear();
        state.down.take().is_some()
    }

    /// Whether the operator is currently being kept from seeing the stream.
    pub fn is_down(&self) -> bool {
        self.lock().down.is_some()
    }

    /// The tap's half: what of this chunk the pane should be shown.
    ///
    /// Borrowed rather than owned on the common path, so a session with no
    /// skill plumbing in flight pays nothing but a lock and a branch.
    pub fn filter<'a>(&self, chunk: &'a [u8]) -> &'a [u8] {
        let mut state = self.lock();
        let Some(end) = state.down else {
            return chunk;
        };
        // A marker may straddle this chunk and the last, so the search runs
        // over the tail of what has already been dropped as well.
        let carried = state.carry.len();
        let mut hay = Vec::with_capacity(carried + chunk.len());
        hay.extend_from_slice(&state.carry);
        hay.extend_from_slice(chunk);

        // Two steps, in order: the engine's answer, and then (for a shell that
        // sends them) the prompt mark behind it. Both can land in one chunk, so
        // this walks rather than returns after the first.
        let mut at = 0;
        if !state.answered {
            match find_answer(&hay) {
                Some(end_of_answer) => {
                    state.answered = true;
                    at = end_of_answer;
                }
                None => {
                    let from = keep_from(&hay, false);
                    state.carry = hay.split_off(from);
                    return &[];
                }
            }
        }
        if end == End::PromptMark {
            match find(&hay[at..], PROMPT_MARK) {
                Some(rel) => at += rel + PROMPT_MARK.len(),
                None => {
                    let from = keep_from(&hay, true).max(at);
                    state.carry = hay.split_off(from);
                    return &[];
                }
            }
        }
        state.down = None;
        state.carry.clear();
        // Back into this chunk's coordinates. A match ending inside the carry
        // is impossible (it would have fired on the chunk that carried it), so
        // this cannot wrap, but saturating beats panicking on a bug elsewhere.
        &chunk[at.saturating_sub(carried).min(chunk.len())..]
    }

    /// A poisoned lock means a panic somewhere else in the run. Recovering the
    /// state is right: refusing to would leave the pane dark for good.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Where in `hay` the next search has to start from, so that a marker split
/// across two reads is still found whole.
///
/// Not simply "the last few bytes". An answer is an *opening* and then whatever
/// runs to the next BEL, so one whose terminator has not arrived yet has to
/// keep its opening: trimming to a fixed tail threw the `ESC ] 6273 ;` away and
/// the answer could never match afterwards. The fixed-length prompt mark is the
/// easy case and falls out of the same rule.
fn keep_from(hay: &[u8], seeking_prompt: bool) -> usize {
    let from = if seeking_prompt {
        partial_at(hay, PROMPT_MARK)
    } else {
        // An opening that has already arrived in full is the anchor; failing
        // that, an opening that has begun.
        find(hay, PROBE_OPEN).unwrap_or_else(|| partial_at(hay, PROBE_OPEN))
    };
    // A shell that opens one of these and never closes it must not be able to
    // grow this without limit. Nothing legitimate comes close: the longest
    // answer the engine asks for is a shell name.
    from.max(hay.len().saturating_sub(MAX_CARRY))
}

/// Where the longest suffix of `hay` that is a prefix of `needle` begins, or
/// the end of `hay` when there is no such suffix.
fn partial_at(hay: &[u8], needle: &[u8]) -> usize {
    // A suffix as long as the whole needle would be a full match, and `find`
    // has already ruled that out. Anything shorter is fair game, including a
    // suffix that is the whole of `hay`.
    let most = hay.len().min(needle.len().saturating_sub(1));
    for len in (1..=most).rev() {
        if hay[hay.len() - len..] == needle[..len] {
            return hay.len() - len;
        }
    }
    hay.len()
}

/// Where the engine's own answer finishes in `hay`, if it is there.
fn find_answer(hay: &[u8]) -> Option<usize> {
    let open = find(hay, PROBE_OPEN)?;
    // The answer runs to its terminator, which may not have arrived.
    let rest = &hay[open + PROBE_OPEN.len()..];
    let bel = rest.iter().position(|b| *b == BEL)?;
    Some(open + PROBE_OPEN.len() + bel + 1)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point, stated once: a pane with the curtain down is a pane
    /// that receives nothing, so there is no blink to time and no row to count.
    #[test]
    fn a_lowered_curtain_forwards_nothing() {
        let c = Curtain::new();
        c.lower(End::PromptMark);
        assert_eq!(c.filter(b" printf '...'\r\n"), b"");
        assert_eq!(c.filter(b"more echo"), b"");
        assert!(c.is_down());
    }

    /// One hidden line's whole reply, as it arrives from a shell running the
    /// integration: the echo, the command-start mark, the answer, the
    /// completion, and the prompt with the mark on the end of it.
    const REPLY: &[u8] = b" printf ...\r\n\x1b]133;C\x07\x1b]6273;__bsuid_0__\x07\
                           \x1b]133;D;0\x07\x1b]133;A\x07user@host:~$ \x1b]133;B\x07";

    #[test]
    fn the_prompt_mark_behind_the_answer_lifts_it_and_keeps_what_follows() {
        let c = Curtain::new();
        c.lower(End::PromptMark);
        let mut chunk = REPLY.to_vec();
        chunk.extend_from_slice(b"rest");
        assert_eq!(c.filter(&chunk), b"rest");
        assert!(!c.is_down());
    }

    /// The staleness rule, which is the whole reason the answer is looked for
    /// first. A prompt mark that was already on the wire when the engine typed
    /// describes the prompt *before* the hidden line, and lifting on it would
    /// put the echo of that line on the glass. zsh produces the same shape by
    /// redrawing its prompt while the line is still being typed.
    #[test]
    fn a_prompt_mark_in_front_of_the_answer_is_somebody_elses() {
        let c = Curtain::new();
        c.lower(End::PromptMark);
        // A stale prompt, then the echo, and only then the real exchange.
        assert_eq!(c.filter(b"\x1b]133;B\x07 printf ...\r\n"), b"");
        assert!(c.is_down(), "an early mark must not have lifted it");
        assert_eq!(c.filter(REPLY), b"");
        assert!(!c.is_down(), "and the one behind the answer must");
    }

    /// The marker arriving in pieces is the normal case on a slow link, and
    /// it is the case a naive per-chunk search gets wrong.
    #[test]
    fn a_marker_split_across_chunks_is_still_found() {
        let c = Curtain::new();
        c.lower(End::PromptMark);
        assert_eq!(c.filter(b"\x1b]6273;__bsuid_0__\x07\x1b]13"), b"");
        assert_eq!(c.filter(b"3;B\x07after"), b"after");
        assert!(!c.is_down());
    }

    /// Split so that the tail of one chunk and the head of the next each hold
    /// part of the marker, with real output behind it.
    #[test]
    fn the_bytes_after_a_split_marker_are_not_swallowed() {
        let c = Curtain::new();
        c.lower(End::PromptMark);
        assert_eq!(c.filter(b"\x1b]6273;__bsuid_0__\x07"), b"");
        assert_eq!(c.filter(b"\x1b]133;"), b"");
        assert_eq!(c.filter(b"B\x07$ ls"), b"$ ls");
    }

    #[test]
    fn a_probe_answer_lifts_the_other_kind() {
        let c = Curtain::new();
        c.lower(End::ProbeAnswer);
        let out = c.filter(b" printf\r\n\x1b]6273;__bsuid_0__\x07\r\x1b[2K$ ");
        assert_eq!(out, b"\r\x1b[2K$ ");
    }

    /// An answer whose terminator has not arrived is not an answer yet: lifting
    /// on the opening bracket alone would show the operator the rest of it.
    #[test]
    fn an_unterminated_probe_answer_does_not_lift_it() {
        let c = Curtain::new();
        c.lower(End::ProbeAnswer);
        assert_eq!(c.filter(b"\x1b]6273;__bsuid_"), b"");
        assert!(c.is_down());
        assert_eq!(c.filter(b"0__\x07tail"), b"tail");
    }

    /// Nothing survives a second lowering: not the carry, and not the fact that
    /// the last line was answered. A curtain that remembered either would lift
    /// on the leavings of the line before it.
    #[test]
    fn lowering_forgets_everything_the_last_one_knew() {
        let c = Curtain::new();
        c.lower(End::PromptMark);
        assert_eq!(c.filter(b"\x1b]6273;__bsuid_0__\x07\x1b]133;"), b"");
        c.lower(End::PromptMark);
        assert_eq!(c.filter(b"B\x07"), b"");
        assert!(c.is_down(), "the answer has to arrive again");
    }

    #[test]
    fn a_raised_curtain_forwards_everything_untouched() {
        let c = Curtain::new();
        let chunk = b"\x1b]133;B\x07 ordinary output";
        assert_eq!(c.filter(chunk), chunk);
    }

    /// The backstop's contract: it says whether it had to do the raising, which
    /// is how the engine knows the row still needs repairing.
    #[test]
    fn raising_by_hand_reports_that_no_marker_came() {
        let c = Curtain::new();
        c.lower(End::PromptMark);
        assert!(c.raise(), "no marker arrived, so the caller must repair");
        assert!(!c.raise(), "already up");
        let chunk = b"$ ";
        assert_eq!(c.filter(chunk), chunk);
    }
}
