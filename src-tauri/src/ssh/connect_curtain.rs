//! Holds a session's first screen back until it is the finished one.
//!
//! # The blink
//!
//! Opening an SSH terminal does not paint one screen, it paints three. The
//! host's login banner streams in and is drawn; Broadside then sends its setup
//! line, whose tail is `clear; cat /run/motd.dynamic /etc/motd; printf '<last
//! login>'` (see [`crate::omni::shell_setup_command`]); the `clear` wipes what
//! was just drawn, and the MOTD is printed again. Banner, blank, banner.
//!
//! On a first connect that is a flicker. On a **reconnect** it is loud, because
//! the pane is not empty when it starts: the dead session's output is still on
//! screen, deliberately, and the operator watches it survive the new banner and
//! then get wiped.
//!
//! # The fix
//!
//! Do the redraw where nobody can see it. The bytes are held on this side until
//! the setup line's own `clear` has landed, and only what follows it is sent to
//! the pane. The pane goes from "connecting" straight to the finished screen, in
//! one paint.
//!
//! Nothing is lost that was not already being thrown away: the `clear` wipes all
//! of it a moment later either way, so the end state on screen is byte for byte
//! what it was before. What changes is how many times it is drawn on the way
//! there.
//!
//! # What it refuses to do
//!
//! **Hold a shell we are not writing to.** A silent host (a console menu, an
//! appliance) is sent nothing at all, so no `clear` is ever coming and there is
//! no second draw to hide. [`Curtain::open_now`] releases everything the instant
//! that is known.
//!
//! **Hold for longer than the screen is worth.** A `clear` that never arrives,
//! because the shell did not run the line, or has no `clear`, or answered
//! something we did not predict, must cost a flicker and not a blank pane. Every
//! hold is against a deadline, and when it passes everything held goes out
//! exactly as it arrived. Late is the old behaviour; never is a broken terminal,
//! and those are not the same bug.
//!
//! **Hold a stream something else is reading.** A skill run taps this same
//! stream, and the engine on the other end of the tap decides a login is over
//! either by finding a prompt mark in it or, on a shell that has no marks, by
//! waiting for it to go quiet. A curtain makes a stream look quiet for as long
//! as it is down, which would have the engine start typing at a host still
//! printing its banner. So the curtain is asked for, not assumed: a terminal tab
//! takes [`FirstScreen::Curtained`] and a skill run takes [`FirstScreen::Raw`],
//! which is this type doing nothing at all. Polish is the thing that gives way
//! when the two are in tension.

use std::time::{Duration, Instant};

/// How long to wait for the setup line's `clear` before giving up and showing
/// what was held.
///
/// Generous, because the thing being waited for is a round trip to a machine
/// that has just accepted a login and may be busy doing it, and the cost of
/// waiting is that a pane which says "connecting" goes on saying it. The cost of
/// giving up early is the blink this exists to remove, so the deadline is set
/// where a human would rather wait than see it.
pub const CLEAR_DEADLINE: Duration = Duration::from_millis(2500);

/// The erase-display sequences a `clear` can come out as, longest first so a
/// prefix never matches ahead of the sequence it is part of.
///
/// `ESC[2J` is what `xterm-256color` gives, which is the terminal type we ask
/// for, so in practice it is always the first. The other two are what a terminfo
/// that clears by homing the cursor and erasing forwards produces, and they are
/// here because the cost of listing them is nothing and the cost of a host that
/// uses one is the curtain waiting out its whole deadline on every connect.
const ERASE_DISPLAY: [&[u8]; 3] = [b"\x1b[2J", b"\x1b[0J", b"\x1b[J"];

/// Sent ahead of the released bytes, so the screen the operator lands on starts
/// at the top.
///
/// The host's own `clear` homes the cursor before erasing, and that home is in
/// the part being discarded. Rather than reach back for it, which means knowing
/// how each terminfo spells it, put an unconditional one in front. A redundant
/// `ESC[H` costs a cursor move to where the cursor already is.
const HOME: &[u8] = b"\x1b[H";

/// Whether this session wants its first screen held back.
///
/// Not a preference: the answer is decided by whether anything other than a
/// person is reading the stream. See the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstScreen {
    /// Hold the login banner and the setup redraw, show the finished screen.
    /// What a terminal tab wants.
    Curtained,
    /// Every byte as it arrives. What a skill run needs, because its engine is
    /// reading this stream too and treats silence as meaning something.
    Raw,
}

/// Whether the first screen is still being held, and why.
#[derive(Debug)]
enum State {
    /// Before the setup line has gone out. What is arriving is the login banner,
    /// which is about to be wiped by our own `clear`.
    Banner,
    /// The setup line has gone out. What is arriving is its echo and then its
    /// output; the screen begins at the erase in the middle of that.
    AwaitingClear { deadline: Instant },
    /// Everything goes straight through, which is the whole session after the
    /// first screen.
    Open,
}

/// What the caller should do with the bytes it just fed in.
#[derive(Debug, PartialEq, Eq)]
pub enum Emit {
    /// Nothing yet: it is being held.
    Nothing,
    /// Send these to the pane. Not necessarily the bytes just fed in: on the
    /// frame the curtain lifts this is the finished screen, assembled from what
    /// was held.
    Bytes(Vec<u8>),
}

/// One session's first-screen curtain. Feed it every chunk the host sends and
/// send on whatever it hands back.
#[derive(Debug)]
pub struct Curtain {
    state: State,
    held: Vec<u8>,
}

impl Curtain {
    /// A curtain in the mode this session asked for. `Raw` starts open and can
    /// never close again, so every call below is a pass-through and the session
    /// loop needs no branch of its own.
    pub fn new(mode: FirstScreen) -> Self {
        Self {
            state: match mode {
                FirstScreen::Curtained => State::Banner,
                FirstScreen::Raw => State::Open,
            },
            held: Vec::new(),
        }
    }

    /// Bytes from the host. Returns what to send to the pane, which is nothing
    /// at all while the curtain is down.
    pub fn feed(&mut self, now: Instant, data: &[u8]) -> Emit {
        match self.state {
            State::Open => Emit::Bytes(data.to_vec()),
            State::Banner => {
                self.held.extend_from_slice(data);
                Emit::Nothing
            }
            State::AwaitingClear { deadline } => {
                self.held.extend_from_slice(data);
                // The screen starts at the erase. Everything before it is the
                // banner we are hiding and the echo of the line that wiped it.
                if let Some(idx) = find_erase(&self.held) {
                    let mut out = HOME.to_vec();
                    out.extend_from_slice(&self.held[idx..]);
                    self.state = State::Open;
                    self.held = Vec::new();
                    return Emit::Bytes(out);
                }
                // Waited long enough. Whatever this shell is doing, it is not
                // the redraw we were hiding, so stop hiding it.
                if now >= deadline {
                    return Emit::Bytes(self.open_now());
                }
                Emit::Nothing
            }
        }
    }

    /// The setup line has been written to the host. From here what is held is
    /// the banner plus the echo of that line, all of which the `clear` in it is
    /// about to make irrelevant, so it is dropped rather than kept.
    pub fn setup_sent(&mut self, now: Instant) {
        if matches!(self.state, State::Open) {
            return;
        }
        self.held = Vec::new();
        self.state = State::AwaitingClear {
            deadline: now + CLEAR_DEADLINE,
        };
    }

    /// Lift the curtain now and hand back everything held, unchanged.
    ///
    /// For the shells that are sent nothing: there is no redraw coming, so what
    /// is being held is not a draft of the screen, it *is* the screen.
    pub fn open_now(&mut self) -> Vec<u8> {
        self.state = State::Open;
        std::mem::take(&mut self.held)
    }

    /// Whether anything is still being held back, i.e. whether a session that is
    /// ending owes the pane bytes it never showed.
    pub fn is_holding(&self) -> bool {
        !matches!(self.state, State::Open)
    }
}

/// Where in `buf` the erase-display sequence starts, if it has arrived.
fn find_erase(buf: &[u8]) -> Option<usize> {
    // Every candidate is scanned rather than stopping at the first match of the
    // first pattern, because `ESC[J` can appear earlier in the stream than the
    // `ESC[2J` that is the real clear (a prompt redraw erasing to end of line is
    // a different sequence, but a program in the banner can legitimately erase
    // forwards). The earliest erase is the safe one to cut at: everything before
    // any erase is being thrown away by the host too.
    ERASE_DISPLAY
        .iter()
        .filter_map(|pat| find_sub(buf, pat))
        .min()
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn the_banner_is_held_and_never_reaches_the_pane() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        assert_eq!(c.feed(now, b"Welcome to Ubuntu\r\n"), Emit::Nothing);
        assert_eq!(c.feed(now, b"Last login: Mon\r\n"), Emit::Nothing);
        c.setup_sent(now);
        // The banner is gone, not queued: the clear was about to wipe it.
        let out = c.feed(now, b" clear; cat /etc/motd\r\n\x1b[H\x1b[2J\x1b[3JMOTD\r\n$ ");
        match out {
            Emit::Bytes(b) => {
                let s = String::from_utf8_lossy(&b).into_owned();
                assert!(!s.contains("Welcome to Ubuntu"));
                assert!(!s.contains("cat /etc/motd"), "the setup echo is hidden too");
                assert!(s.contains("MOTD"));
                assert!(s.ends_with("$ "));
                assert!(b.starts_with(HOME));
            }
            Emit::Nothing => panic!("the clear arrived, so the screen should have gone out"),
        }
    }

    #[test]
    fn the_erase_survives_being_split_across_chunks() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now);
        assert_eq!(c.feed(now, b" setup line\r\n\x1b[H\x1b"), Emit::Nothing);
        // The `[2J` lands in the next chunk; the sequence still has to be found.
        match c.feed(now, b"[2JMOTD") {
            Emit::Bytes(b) => {
                assert_eq!(b, [HOME, b"\x1b[2JMOTD"].concat());
            }
            Emit::Nothing => panic!("a sequence split over two chunks is still a sequence"),
        }
    }

    #[test]
    fn everything_after_the_curtain_lifts_goes_straight_out() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now);
        let _ = c.feed(now, b"\x1b[2J$ ");
        assert!(!c.is_holding());
        assert_eq!(c.feed(now, b"ls\r\n"), Emit::Bytes(b"ls\r\n".to_vec()));
        assert_eq!(c.feed(now, b"a b c"), Emit::Bytes(b"a b c".to_vec()));
    }

    /// A host that is sent nothing has no redraw coming, so what it has already
    /// said is the screen and it goes out as it arrived.
    #[test]
    fn a_silent_host_gets_its_banner_back_unchanged() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        assert_eq!(c.feed(now, b"1) Assign Interfaces\r\n"), Emit::Nothing);
        assert_eq!(c.feed(now, b"2) Set console\r\n"), Emit::Nothing);
        assert_eq!(
            c.open_now(),
            b"1) Assign Interfaces\r\n2) Set console\r\n".to_vec()
        );
        assert!(!c.is_holding());
        // And from then on it is a plain pass-through.
        assert_eq!(c.feed(now, b"Enter: "), Emit::Bytes(b"Enter: ".to_vec()));
    }

    /// The one that must never regress: a clear that never comes costs a
    /// flicker, not a pane that stays empty.
    #[test]
    fn a_clear_that_never_arrives_gives_everything_back_at_the_deadline() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now);
        assert_eq!(c.feed(now, b"sh: clear: not found\r\n"), Emit::Nothing);
        let late = now + CLEAR_DEADLINE + Duration::from_millis(1);
        match c.feed(late, b"$ ") {
            Emit::Bytes(b) => {
                assert_eq!(b, b"sh: clear: not found\r\n$ ".to_vec());
                assert!(!b.starts_with(HOME), "nothing was cut, so nothing to home");
            }
            Emit::Nothing => panic!("the deadline passed; the pane must not stay empty"),
        }
        assert!(!c.is_holding());
    }

    /// A shell whose terminfo clears by homing and erasing forwards.
    #[test]
    fn an_erase_to_end_of_display_counts_as_a_clear() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now);
        match c.feed(now, b"echo\r\n\x1b[H\x1b[Jready") {
            Emit::Bytes(b) => assert_eq!(b, [HOME, b"\x1b[Jready"].concat()),
            Emit::Nothing => panic!("ESC[J after a home is a cleared screen"),
        }
    }

    /// A skill run's stream is read by the engine as well as by a person, and
    /// the engine treats silence as an answer. Raw mode is this whole file
    /// declining to have an opinion.
    #[test]
    fn raw_mode_passes_everything_straight_through() {
        let mut c = Curtain::new(FirstScreen::Raw);
        let now = t0();
        assert!(!c.is_holding());
        assert_eq!(
            c.feed(now, b"Welcome to Ubuntu\r\n"),
            Emit::Bytes(b"Welcome to Ubuntu\r\n".to_vec())
        );
        // Even the events that would close a curtain leave this one open.
        c.setup_sent(now);
        assert!(!c.is_holding());
        assert_eq!(
            c.feed(now, b"\x1b[H\x1b[2JMOTD"),
            Emit::Bytes(b"\x1b[H\x1b[2JMOTD".to_vec()),
            "nothing is cut and no home is inserted"
        );
    }

    #[test]
    fn setup_sent_after_the_curtain_is_open_changes_nothing() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        let _ = c.open_now();
        c.setup_sent(now);
        assert!(!c.is_holding());
        assert_eq!(c.feed(now, b"x"), Emit::Bytes(b"x".to_vec()));
    }
}
