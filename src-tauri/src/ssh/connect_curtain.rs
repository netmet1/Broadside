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
//! # The line itself
//!
//! The setup line is typed at a shell, so the host reads it back to us before it
//! runs it: a thousand characters of `if [ -n "$BASH_VERSION" ]; then ...`
//! arriving on the same stream as everything else. On the good path that is
//! already invisible, because the cut is made at the `clear` and the echo is in
//! front of it. The path that showed it was the deadline below: what is held
//! goes out as it stands, and what is held is mostly that line. On a slow link
//! that is the whole of what flashes past, and it is the one thing on this
//! stream that the operator certainly did not type.
//!
//! So the echo is recognised rather than merely outrun. What was written is
//! kept and matched against what comes back, which buys two things. The
//! deadline is pushed out for as long as more of the line keeps arriving, since
//! a host still repeating it cannot have reached the `clear` yet, and that is
//! the difference between a deadline on the host and a deadline on the network.
//! And whatever this file does release, it releases without that line in it:
//! what the operator is left looking at is what the host said, never the
//! sentence Broadside typed to make it say it.
//!
//! # The shells that do not echo, they redraw
//!
//! "Reads it back to us" is what bash does, and it is not what a shell has to
//! do. Bash's line editor writes the characters it was handed, in order, and
//! lets the terminal wrap them, so what comes back is byte for byte what went
//! out. zsh's does not: it renders the line, and at every wrap it emits a
//! padding space, a carriage return, an erase-to-end-of-line, the character
//! that wrapped, a second carriage return, and that character over again.
//!
//! Measured, not assumed. A real zsh 5.9 under a pty on `xterm-256color` gives
//! back 1146 bytes for the 837 that were written, and a matcher that insists on
//! byte for byte recognises 75 of them: everything up to the first wrap, which
//! is one row of the screen. Bash, on the same test, gives 838 of 837.
//!
//! Both halves of what the recognition buys were therefore lost on zsh and only
//! on zsh. The deadline stopped being pushed after the first row came back, so
//! it went back to being measured from the write, which is the network deadline
//! this file exists to stop using. And a deadline that then passed released
//! 1071 of those 1146 bytes, `__omni_precmd` and all, onto the screen. That is
//! the blink, on the shells that redraw, on the hosts slow enough to reach the
//! deadline, and never on bash.
//!
//! So the walk steps over a line editor's own redraw: a short run of bytes
//! between two characters of ours is the editor drawing, not the host talking.
//! See [`REDRAW_SLACK`] for how short, and why there is a limit at all.
//!
//! It comes back twice, as well. The terminal driver on the host echoes what
//! arrives at it whether or not any program is reading, and the login shell then
//! draws the same characters over again when it gets round to reading them as
//! keystrokes. So a copy lands at the instant of the write, before the shell has
//! read a word of its own rc, and a second one lands whenever the shell is
//! ready. Every copy is taken out, not the first.
//!
//! # The prompt that erases
//!
//! The cut is made at the host's `clear`, and for two years "the host's `clear`"
//! meant the first erase-display sequence on the stream. That is not what an
//! erase-display means. This is a real zsh 5.9 drawing an ordinary prompt:
//!
//! ```text
//! ESC[0m ESC[27m ESC[24m ESC[J probe ESC[K
//! ```
//!
//! `ESC[J` erases from the cursor to the end of the display, and a shell about
//! to draw a prompt has every right to use it: it is clearing its own ground,
//! below its own cursor. But it was the first erase on the stream, so the cut
//! was made there, and everything after it went to the pane: the prompt, then
//! the shell's redraw of our setup line, in full, and then the real `clear`
//! wiping it. On the measured login that is 1370 bytes released with
//! `BASH_VERSION`, `__omni_precmd` and `add-zsh-hook` in them, where the right
//! cut releases 429 with none of them.
//!
//! Every time, on every zsh, and never on bash, whose prompt is
//! `ESC[?2004h user@host$ ` with no erase in it anywhere. That is exactly the
//! shape the bug was reported in.
//!
//! What separates them is where the cursor is. A `clear` homes first and then
//! erases, so erasing forwards is erasing everything; a prompt erases from
//! wherever it happens to be. So `ESC[2J`, which erases the whole display and
//! which nothing draws a prompt with, is taken wherever it appears, and an erase
//! forwards is taken only with a cursor home immediately in front of it. See
//! [`HOMES`].
//!
//! What that does not cover: a host that clears its own screen in its rc file,
//! between our write and our `clear`. The cut would be made at that one, and
//! what follows it is the shell's redraw of our line. So the release is stripped
//! of our line on both paths rather than only on the deadline, which turns a
//! wrong cut from something an operator reads into something nobody can see.
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
/// Counted from the last byte of our own line to come back, not from the write,
/// so it is a deadline on the host and not on the link. Once the shell has
/// finished reading the line it is about to run it, and everything from there is
/// local to the machine; before that we are watching a round trip, and how long
/// one of those takes is not something this file gets an opinion about. A VPN on
/// hotel wireless was blowing a deadline measured from the write on every
/// connect, and every connect showed the line.
///
/// It does not start until the host has said a word of its own, for the same
/// reason read the other way. The line goes out when sshd prints the last-login
/// line, which is before the login shell has read the first line of its own rc,
/// and a `.zshrc` with a framework in it can spend seconds there. Expiring in
/// the middle of that silence shows nobody anything sooner, because nothing is
/// being held to show; all it does is open the curtain, so the redraw that
/// arrives a moment later goes straight to the screen.
///
/// "A word of its own" and not "a byte", because the host is not silent in that
/// gap: its terminal driver echoes our line back the instant it arrives,
/// complete, with no shell involved. Counting that as the host answering starts
/// this clock at the write again, which is where it came in. [`HOLD_CAP`] is the
/// answer to a host that says nothing at all.
///
/// Generous even so, because a machine that has just accepted a login may be
/// busy doing it, and the cost of waiting is that a pane which says "connecting"
/// goes on saying it. The cost of giving up early is the blink this exists to
/// remove, so the deadline is set where a human would rather wait than see it.
pub const CLEAR_DEADLINE: Duration = Duration::from_millis(2500);

/// Erase the whole display. What `clear` comes out as on `xterm-256color`,
/// which is the terminal type we ask for, so in practice it is always this one.
///
/// Taken as a `clear` wherever it appears, because nothing else emits it. A line
/// editor erases from where the cursor is; it has no reason to wipe a screen it
/// does not own.
const ERASE_ALL: &[u8] = b"\x1b[2J";

/// Erase from the cursor to the end of the display.
///
/// A `clear` on a terminfo that homes first and then erases forwards ends in one
/// of these: `vt100`, `linux` and `ansi` all spell it `ESC[H ESC[J`. So does
/// every prompt zsh has ever drawn, which is the whole difficulty. See
/// [`HOMES`].
const ERASE_FORWARD: [&[u8]; 2] = [b"\x1b[0J", b"\x1b[J"];

/// The cursor homes a `clear` does before it erases forwards.
///
/// This is what tells the two apart, and it is the fix for a bug that put the
/// setup line on the screen at every single zsh connect. Erasing forwards from
/// the top left is erasing everything, which is a `clear`. Erasing forwards from
/// wherever the cursor happens to be is a shell tidying up after itself before
/// it draws a prompt, and that is nobody's screen but its own.
///
/// Measured on a real zsh 5.9: every prompt it draws is `ESC[0m ESC[27m ESC[24m
/// ESC[J`, three times in one login, and its `clear` is `ESC[H ESC[2J ESC[3J`.
/// Bash draws its prompt with no erase in it at all, which is why this was only
/// ever a bug on one of the two.
///
/// `ESC[H` is what `xterm` and most others use. The other two are the same
/// instruction spelled out, and cost nothing to accept.
const HOMES: [&[u8]; 3] = [b"\x1b[H", b"\x1b[;H", b"\x1b[1;1H"];

/// The longest a first screen is ever held, whatever is arriving.
///
/// The deadline above restarts every time more of our own line comes back, which
/// is right for a slow link and wrong for a host that dribbles it back a byte at
/// a time: a thousand restarts of two and a half seconds is a pane that says
/// "connecting" for an hour. This is the backstop that cannot be pushed, so the
/// worst case is a flicker after ten seconds rather than a tab that never
/// arrives.
///
/// It is also the whole of the wait for a host that never answers the line,
/// since the deadline above has no host-side clock to run until one of them
/// does. A pane holding on "connecting" that long is a pane whose host has said
/// nothing since it accepted the login, which is worth being told about, and
/// the connecting overlay says so on its own.
const HOLD_CAP: Duration = Duration::from_secs(10);

/// How much of our own line has to be seen before a run of bytes is called its
/// echo.
///
/// Long enough that no host prints it by accident, short enough that a line the
/// deadline caught halfway back is still recognised for what it is.
///
/// Matched verbatim, which is the one thing every shell here does the same way:
/// the anchor sits at the start of the line, and a line editor's redraw only
/// interrupts at a wrap. A prompt wide enough to leave fewer than this many
/// columns on its own row would split the anchor and the echo would go
/// unrecognised, which is the old behaviour and not a new failure.
const ECHO_ANCHOR: usize = 16;

/// How many bytes a line editor may put between two characters of ours before
/// the run stops being our line.
///
/// The whole of the wrap dance zsh 5.9 performs is ten bytes at its longest,
/// and four in the common case. Sixty-four leaves room for an editor that
/// colours what it draws, and for a terminfo that spells the same erase at
/// greater length.
///
/// There is a limit at all because this is what decides which bytes are taken
/// off somebody's screen. Without one, a walk that ran out of our line halfway
/// could pick its remaining characters out of the host's own output and take
/// the host's words away with them. A gap longer than a redraw is the host
/// talking, and the walk stops there.
const REDRAW_SLACK: usize = 64;

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
    ///
    /// `deadline` moves as the echo arrives; `cap` is where it stops moving.
    /// `heard` is whether the host has said anything since the write, because
    /// until it has there is no host-side clock to run and `deadline` is the
    /// cap.
    AwaitingClear {
        deadline: Instant,
        cap: Instant,
        heard: bool,
    },
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
    /// Exactly what was written to the host, kept so its echo can be told apart
    /// from what the host has to say for itself. Empty for a session that is
    /// sent nothing.
    echo: Vec<u8>,
    /// How much of that echo has been seen. Only ever grows, and growing is what
    /// pushes the deadline out.
    echo_seen: usize,
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
            echo: Vec::new(),
            echo_seen: 0,
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
            State::AwaitingClear {
                mut deadline,
                cap,
                mut heard,
            } => {
                self.held.extend_from_slice(data);
                let copies = find_echoes(&self.held, &self.echo);
                let seen: usize = copies.iter().map(|e| e.matched).sum();
                let ours: usize = copies.iter().map(|e| e.span).sum();
                // What is here that we did not put here. Our own line coming
                // back is not the host speaking, and neither is the beginning of
                // a copy of it that is still too short to recognise.
                let theirs = self
                    .held
                    .len()
                    .saturating_sub(ours)
                    .saturating_sub(pending_echo(&self.held, &self.echo));
                // The host's first word of its own is where the clock starts.
                // Before it the host has told us nothing: the line goes out when
                // sshd prints the last-login line, and the shell may not have
                // read the first line of its rc yet.
                if !heard && theirs > 0 {
                    heard = true;
                    deadline = (now + CLEAR_DEADLINE).min(cap);
                }
                // More of our own line coming back is not the host answering, it
                // is the host still reading, so the clock starts again. Without
                // this the deadline is really a guess at somebody's latency.
                // Forwards only: a line still arriving cannot be a reason to give
                // up sooner than we already meant to.
                if seen > self.echo_seen {
                    self.echo_seen = seen;
                    if heard {
                        deadline = deadline.max((now + CLEAR_DEADLINE).min(cap));
                    }
                }
                self.state = State::AwaitingClear {
                    deadline,
                    cap,
                    heard,
                };
                // The screen starts at the erase. Everything before it is the
                // banner we are hiding and the echo of the line that wiped it.
                //
                // Stripped even so. Nothing of ours should be on the far side of
                // the host's own `clear`, and on every host measured nothing is,
                // but the promise this file makes is about what leaves it and not
                // about what it expects to find.
                if let Some(idx) = find_erase(&self.held) {
                    let mut out = HOME.to_vec();
                    out.extend_from_slice(&strip_echo(&self.held[idx..], &self.echo));
                    self.held = Vec::new();
                    self.lift();
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
    ///
    /// `written` is exactly what went out. Keeping it is what lets the echo be
    /// recognised on the way back rather than shown to somebody.
    pub fn setup_sent(&mut self, now: Instant, written: &[u8]) {
        if matches!(self.state, State::Open) {
            return;
        }
        self.held = Vec::new();
        self.echo = written.to_vec();
        self.echo_seen = 0;
        self.state = State::AwaitingClear {
            // Not `CLEAR_DEADLINE`: nothing has been heard yet, so there is no
            // host to be late. See the constant.
            deadline: now + HOLD_CAP,
            cap: now + HOLD_CAP,
            heard: false,
        };
    }

    /// When this curtain next needs looking at, so a session loop can park a
    /// timer on it. `None` once it is open.
    ///
    /// It has to be asked again after every chunk rather than armed once,
    /// because the answer moves for as long as our own line is still arriving.
    pub fn deadline(&self) -> Option<Instant> {
        match self.state {
            State::AwaitingClear { deadline, .. } => Some(deadline),
            _ => None,
        }
    }

    /// Lift the curtain now and hand back everything held, less our own line.
    ///
    /// For the shells that are sent nothing: there is no redraw coming, so what
    /// is being held is not a draft of the screen, it *is* the screen, and
    /// nothing was written to them, so there is nothing in it to take out.
    ///
    /// For a shell that took the line and then did not clear, the echo is the
    /// one thing here that is certainly not the host's own output, and this is
    /// the path that used to put it on somebody's screen.
    pub fn open_now(&mut self) -> Vec<u8> {
        let held = std::mem::take(&mut self.held);
        let out = strip_echo(&held, &self.echo);
        self.lift();
        out
    }

    /// Up for good: nothing more to hold, and nothing more to recognise.
    fn lift(&mut self) {
        self.state = State::Open;
        self.echo = Vec::new();
        self.echo_seen = 0;
    }

    /// Whether anything is still being held back, i.e. whether a session that is
    /// ending owes the pane bytes it never showed.
    pub fn is_holding(&self) -> bool {
        !matches!(self.state, State::Open)
    }
}

/// Where in `buf` the host's `clear` starts, if it has arrived.
///
/// The earliest one, because everything in front of an erase is being thrown
/// away by the host as well, so cutting at the first is never cutting away
/// something a person was going to keep.
///
/// The host's `clear` and not merely an erase: an erase forwards counts only
/// when a cursor home is the thing immediately in front of it. See [`HOMES`].
fn find_erase(buf: &[u8]) -> Option<usize> {
    let all = find_sub(buf, ERASE_ALL);
    // Every occurrence and not just the first, because the first can be a prompt
    // and the second the real thing.
    let forward = ERASE_FORWARD
        .iter()
        .flat_map(|pat| occurrences(buf, pat))
        .filter(|&i| HOMES.iter().any(|home| buf[..i].ends_with(home)))
        .min();
    match (all, forward) {
        (Some(a), Some(f)) => Some(a.min(f)),
        (a, f) => a.or(f),
    }
}

/// What was found of our own line in a buffer.
///
/// Two numbers rather than one, because a shell that redraws makes them
/// different: the bytes of the buffer that belong to the echo are the
/// characters plus the editor's own drawing in between, and only the characters
/// say how far the host has got.
#[derive(Debug, Clone, Copy)]
struct Echo {
    /// Where it starts in the buffer.
    start: usize,
    /// How much of the buffer it covers, redraw and all. What comes out.
    span: usize,
    /// How many bytes of the line itself were recognised. The progress signal:
    /// a host still adding to this has not reached the `clear`.
    matched: usize,
}

/// Where the host's echo of our own line sits in `buf`, and how much of it has
/// arrived, or `None` if it has not started.
///
/// Anchored rather than assumed to be at the front: the prompt the shell drew
/// while the line was in flight lands ahead of it, and so does the tail of a
/// banner that was still streaming when we wrote.
///
/// Past the anchor the walk allows for a line editor redrawing rather than
/// echoing, stepping over a short run of bytes that are not ours and refusing a
/// long one. See [`REDRAW_SLACK`].
/// `from` is where the search starts, which is how the second and later copies
/// are found. See [`find_echoes`].
fn find_echo_from(buf: &[u8], echo: &[u8], from: usize) -> Option<Echo> {
    if echo.is_empty() || from >= buf.len() {
        return None;
    }
    let anchor = &echo[..ECHO_ANCHOR.min(echo.len())];
    let start = from + find_sub(&buf[from..], anchor)?;
    let mut i = start;
    let mut j = 0;
    // One past the last byte that was certainly ours. Not `i`: a run stepped
    // over on the way to a character we never found is the host's, and taking
    // it off the screen is the mistake this is here to avoid.
    let mut end = start;
    let mut slack = 0;
    while i < buf.len() && j < echo.len() {
        if buf[i] == echo[j] {
            i += 1;
            j += 1;
            end = i;
            slack = 0;
        } else if buf[i] == b'\r' && echo[j] == b'\n' {
            // The terminal turns the newline that ran the line into CR LF on the
            // way back. That newline is the only one in it, and it is the last
            // byte, so this costs one comparison at the very end.
            i += 1;
            end = i;
        } else {
            // A line editor drawing what it was handed, or the host starting to
            // answer. Which of the two it is, is a question of how long it goes
            // on for.
            slack += 1;
            if slack > REDRAW_SLACK {
                break;
            }
            i += 1;
        }
    }
    Some(Echo {
        start,
        span: end - start,
        matched: j,
    })
}

/// Every run of `buf` that is our own line coming back, in order.
///
/// Every, because the line is echoed more than once. The terminal driver on the
/// host echoes what arrives at it whether or not any program is reading, and the
/// login shell draws the same characters again when it finally gets round to
/// reading them as keystrokes. Measured on a shell with three seconds of rc file
/// to get through: 838 bytes at the instant of the write, and another 917 three
/// seconds later. A pass that took out the first copy left the second one on
/// somebody's screen.
fn find_echoes(buf: &[u8], echo: &[u8]) -> Vec<Echo> {
    let mut out = Vec::new();
    let mut from = 0;
    while from < buf.len() {
        match find_echo_from(buf, echo, from) {
            // `max(1)` only so that a zero-length find could not loop; the
            // anchor having matched means the span is at least one byte.
            Some(e) => {
                from = e.start + e.span.max(1);
                out.push(e);
            }
            None => break,
        }
    }
    out
}

/// How much of a copy too short to recognise yet is sitting at the end of `buf`.
///
/// [`ECHO_ANCHOR`] bytes have to arrive before a run can be called our line, and
/// between the first byte and the sixteenth those bytes would otherwise count as
/// the host having said something. It has not: that is our own line, arriving
/// slowly. This is what stops a link delivering the echo a few bytes at a time
/// from starting a clock that is meant to start when the host speaks.
fn pending_echo(buf: &[u8], echo: &[u8]) -> usize {
    let max = (ECHO_ANCHOR - 1).min(buf.len()).min(echo.len());
    (1..=max)
        .rev()
        .find(|&n| buf[buf.len() - n..] == echo[..n])
        .unwrap_or(0)
}

/// `buf` without any copy of the echo of our own line.
fn strip_echo(buf: &[u8], echo: &[u8]) -> Vec<u8> {
    let copies = find_echoes(buf, echo);
    if copies.is_empty() {
        return buf.to_vec();
    }
    let mut out = Vec::with_capacity(buf.len());
    let mut at = 0;
    for e in copies {
        out.extend_from_slice(&buf[at..e.start]);
        at = e.start + e.span;
    }
    out.extend_from_slice(&buf[at..]);
    out
}

fn find_sub(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// Every offset in `haystack` where `needle` starts.
fn occurrences(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return Vec::new();
    }
    haystack
        .windows(needle.len())
        .enumerate()
        .filter(|(_, w)| *w == needle)
        .map(|(i, _)| i)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    /// A setup line in the shape of the real one: leading space, the shell test,
    /// the hook, the clear, and the newline that runs it.
    const SETUP: &[u8] =
        b" if [ -n \"$BASH_VERSION\" ]; then __omni_precmd() { :; }; fi; clear; cat /etc/motd\n";

    /// The same line as the host reads it back, which is byte for byte what was
    /// written except that the terminal makes CR LF of the newline.
    fn echoed(line: &[u8]) -> Vec<u8> {
        let mut v = line[..line.len() - 1].to_vec();
        v.extend_from_slice(b"\r\n");
        v
    }

    /// What a real zsh 5.9 gives back for `ZSH_TYPED`, captured under a pty on
    /// `xterm-256color` in a 24-column pane behind a two-column prompt.
    ///
    /// It is not an echo. zsh renders the line: the first character, a
    /// backspace, the line as far as the edge of the pane, and then, at the
    /// wrap, a padding space, a carriage return, an erase-to-end-of-line, the
    /// character that wrapped, a second carriage return, and that character
    /// again. Nine bytes that were never typed, in the middle of twenty-nine
    /// that were.
    const ZSH_TYPED: &[u8] = b"# one two three four five six";
    const ZSH_REDRAWN: &[u8] = b"#\x08# one two three fou \r\x1b[Kr\rr five six";

    /// An ordinary prompt from a real zsh 5.9, captured byte for byte. The
    /// `ESC[J` in the middle of it is what the cut used to be made at, on every
    /// connect, releasing the redraw of the setup line that came after it.
    const ZSH_PROMPT: &[u8] = b"\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jprobe\x1b[K\x1b[?2004h";

    /// And the `clear` from the same login, which is the one that should be cut
    /// at: bracketed paste off, the newline that ran the line, then a home and
    /// the erase.
    const ZSH_CLEAR: &[u8] = b"\x1b[?2004l\r\r\n\x1b[H\x1b[2J\x1b[3J";

    /// zsh's mark for output that did not end in a newline, which is the first
    /// thing it says on a login and so the first thing that is really the host
    /// talking. The run of spaces is shortened here; the shape is the capture's.
    const ZSH_PARTIAL_LINE: &[u8] = b"\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m      \r \r";

    /// The same line at the same width from a real bash 5.2, for the contrast:
    /// readline writes what it was handed and lets the terminal wrap it, so
    /// there is nothing in here that was not typed.
    const BASH_ECHOED: &[u8] = b"# one two three four five six\r\n";

    /// `line` as a shell that redraws would give it back, modelled on
    /// `ZSH_REDRAWN` above. For the lines that are too long to write out.
    fn redrawn(line: &[u8], cols: usize, prompt: usize) -> Vec<u8> {
        let mut out = vec![line[0], 0x08];
        let mut col = prompt;
        let mut i = 0;
        while i < line.len() {
            if line[i] == b'\n' {
                out.extend_from_slice(b"\r\n");
                i += 1;
                continue;
            }
            if col + 1 >= cols && i + 1 < line.len() {
                out.extend_from_slice(b" \r\x1b[K");
                out.push(line[i]);
                out.push(b'\r');
                out.push(line[i]);
                col = 1;
                i += 1;
                continue;
            }
            out.push(line[i]);
            col += 1;
            i += 1;
        }
        out
    }

    #[test]
    fn the_banner_is_held_and_never_reaches_the_pane() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        assert_eq!(c.feed(now, b"Welcome to Ubuntu\r\n"), Emit::Nothing);
        assert_eq!(c.feed(now, b"Last login: Mon\r\n"), Emit::Nothing);
        c.setup_sent(now, b" clear; cat /etc/motd\n");
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
        c.setup_sent(now, b" setup line\n");
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
        c.setup_sent(now, SETUP);
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
        c.setup_sent(now, SETUP);
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
        c.setup_sent(now, b" echo\n");
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
        c.setup_sent(now, SETUP);
        assert!(!c.is_holding());
        assert_eq!(
            c.feed(now, b"\x1b[H\x1b[2JMOTD"),
            Emit::Bytes(b"\x1b[H\x1b[2JMOTD".to_vec()),
            "nothing is cut and no home is inserted"
        );
    }

    /// The one this was written for. A `clear` that never comes must not put
    /// the line Broadside typed on somebody's screen, however long it waits.
    #[test]
    fn our_own_line_is_never_released_even_when_the_deadline_passes() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        // The prompt the shell had already drawn lands ahead of the echo, which
        // is why the echo cannot be looked for at the front of the buffer.
        assert_eq!(c.feed(now, b"user@web-01:~$ "), Emit::Nothing);
        assert_eq!(c.feed(now, &echoed(SETUP)), Emit::Nothing);
        let late = now + CLEAR_DEADLINE + Duration::from_millis(1);
        match c.feed(late, b"sh: clear: not found\r\n") {
            Emit::Bytes(b) => {
                assert_eq!(b, b"user@web-01:~$ sh: clear: not found\r\n".to_vec());
            }
            Emit::Nothing => panic!("the deadline passed; the pane must not stay empty"),
        }
        assert!(!c.is_holding());
    }

    /// A link slow enough to blow the old deadline on its own. The line takes
    /// longer to come back than the whole deadline, twice over, and none of that
    /// counts against the host.
    #[test]
    fn a_line_still_coming_back_pushes_the_deadline_out() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        let half = SETUP.len() / 2;
        let late = now + CLEAR_DEADLINE - Duration::from_millis(1);
        assert_eq!(c.feed(late, &SETUP[..half]), Emit::Nothing);
        assert!(c.deadline().expect("still holding") > late);
        let later = late + CLEAR_DEADLINE - Duration::from_millis(1);
        assert_eq!(c.feed(later, &SETUP[half..]), Emit::Nothing);
        assert!(c.is_holding(), "our own line is not a reason to give up");
        // And the screen it was waiting for is cut in the usual place.
        match c.feed(later, b"\r\n\x1b[H\x1b[2JMOTD\r\n$ ") {
            Emit::Bytes(b) => {
                let s = String::from_utf8_lossy(&b).into_owned();
                assert!(!s.contains("BASH_VERSION"), "showed the line: {s}");
                assert!(s.ends_with("MOTD\r\n$ "));
            }
            Emit::Nothing => panic!("the clear arrived, so the screen should have gone out"),
        }
    }

    /// The deadline moves, but not for ever: a host feeding its echo back one
    /// slow byte at a time must not hold a pane on "connecting" all afternoon.
    #[test]
    fn the_deadline_can_be_pushed_but_only_so_far() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        // Long enough that the dribble outlasts the cap several times over, so
        // the test does not turn on how long the real line happens to be. The
        // chunks have to clear ECHO_ANCHOR or there is nothing to recognise.
        let line = SETUP.repeat(4);
        c.setup_sent(now, &line);
        let mut at = now;
        for chunk in line.chunks(ECHO_ANCHOR + 1) {
            at += Duration::from_secs(2);
            if let Emit::Bytes(b) = c.feed(at, chunk) {
                assert!(
                    at >= now + HOLD_CAP,
                    "gave up at {:?}, before the cap",
                    at - now
                );
                assert!(
                    !String::from_utf8_lossy(&b).contains("BASH_VERSION"),
                    "and still without our own line in it"
                );
                assert!(!c.is_holding());
                return;
            }
        }
        panic!("a dribbling host held the curtain for the whole line");
    }

    /// A host that does not echo at all (a menu, a device that takes the line
    /// and says nothing back) must be no worse off than before: what it said is
    /// what it gets, and none of this looks for a line that is not there.
    #[test]
    fn a_host_that_never_echoes_gets_its_own_output_back_whole() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        assert_eq!(c.feed(now, b"Command not recognised.\r\n"), Emit::Nothing);
        let late = now + CLEAR_DEADLINE + Duration::from_millis(1);
        match c.feed(late, b"> ") {
            Emit::Bytes(b) => assert_eq!(b, b"Command not recognised.\r\n> ".to_vec()),
            Emit::Nothing => panic!("the deadline passed; the pane must not stay empty"),
        }
    }

    #[test]
    fn an_open_curtain_has_no_deadline_to_wait_on() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        assert!(c.deadline().is_none(), "nothing has been written yet");
        c.setup_sent(now, SETUP);
        assert!(c.deadline().is_some());
        let _ = c.open_now();
        assert!(c.deadline().is_none());
        assert!(Curtain::new(FirstScreen::Raw).deadline().is_none());
    }

    #[test]
    fn setup_sent_after_the_curtain_is_open_changes_nothing() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        let _ = c.open_now();
        c.setup_sent(now, SETUP);
        assert!(!c.is_holding());
        assert_eq!(c.feed(now, b"x"), Emit::Bytes(b"x".to_vec()));
    }
    /// The measurement this file was rewritten for. A shell that redraws the
    /// line instead of echoing it is still recognised as having read it.
    ///
    /// Before, the walk stopped at the first wrap: on a real 837-byte setup
    /// line at 80 columns that is 75 bytes, one row of the screen, nine per
    /// cent. Everything after it was taken for the host answering.
    #[test]
    fn a_shell_that_redraws_the_line_is_still_read_as_having_read_it() {
        let e = find_echo_from(ZSH_REDRAWN, ZSH_TYPED, 0).expect("the anchor is in there verbatim");
        assert_eq!(
            e.matched,
            ZSH_TYPED.len(),
            "every character of ours came back; the wrap dance is not the host talking"
        );
        assert_eq!(e.start, 2, "after the character zsh echoes and backspaces over");
        // And what it covers is the drawing as well as the characters, so
        // nothing of the dance is left on screen either.
        assert_eq!(&ZSH_REDRAWN[e.start + e.span..], b"");
        assert_eq!(strip_echo(ZSH_REDRAWN, ZSH_TYPED), b"#\x08".to_vec());
    }

    /// The shell that made the strict walk look right for two years.
    #[test]
    fn bash_hands_the_line_back_exactly_as_it_was_given() {
        let e = find_echo_from(BASH_ECHOED, ZSH_TYPED, 0).expect("verbatim, so trivially found");
        assert_eq!(e.matched, ZSH_TYPED.len());
        assert_eq!(e.start, 0);
        // Only the CR LF the terminal made of the newline that ran it is left,
        // and that is the host's, not ours.
        assert_eq!(strip_echo(BASH_ECHOED, ZSH_TYPED), b"\r\n".to_vec());
    }

    /// The consequence on the deadline, which is the half nobody sees. A host
    /// still redrawing our line is a host that has not reached the `clear`, and
    /// it has to buy the same time as a host still echoing it.
    #[test]
    fn a_redrawn_line_pushes_the_deadline_like_an_echoed_one() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        let back = redrawn(SETUP, 80, 14);
        let half = back.len() / 2;
        let late = now + CLEAR_DEADLINE - Duration::from_millis(1);
        assert_eq!(c.feed(late, &back[..half]), Emit::Nothing);
        assert!(
            c.deadline().expect("still holding") > late,
            "the first row was recognised, the rest has to be too"
        );
        let later = late + CLEAR_DEADLINE - Duration::from_millis(1);
        assert_eq!(c.feed(later, &back[half..]), Emit::Nothing);
        assert!(c.is_holding(), "our own line is not a reason to give up");
    }

    /// And the half somebody does see: a `clear` that never comes must not put
    /// a redrawn line on the screen either.
    #[test]
    fn a_redrawn_line_is_not_released_when_the_deadline_passes() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        assert_eq!(c.feed(now, b"root@fw-01# "), Emit::Nothing);
        assert_eq!(c.feed(now, &redrawn(SETUP, 80, 12)), Emit::Nothing);
        let late = now + HOLD_CAP + Duration::from_millis(1);
        match c.feed(late, b"zsh: clear: command not found\r\n") {
            Emit::Bytes(b) => {
                let seen = String::from_utf8_lossy(&b).into_owned();
                assert!(!seen.contains("BASH_VERSION"), "showed the line: {seen}");
                assert!(!seen.contains("omni_precmd"), "showed the line: {seen}");
                // Two bytes of the line survive, and they are the two in
                // front of the anchor: the character zsh echoes before it
                // starts drawing, and the backspace it puts over it. They
                // cancel each other out on the screen, and reaching behind a
                // match to take them out would be modelling one shell's habits
                // rather than recognising a line.
                assert_eq!(seen, "root@fw-01#  \u{8}zsh: clear: command not found\r\n");
            }
            Emit::Nothing => panic!("the deadline passed; the pane must not stay empty"),
        }
    }

    /// The other way to the same blink, and no slow link anywhere near it. The
    /// setup line goes out when sshd prints the last-login line, which is before
    /// the login shell has read a word of its own rc, so a `.zshrc` with a
    /// framework in it spends the whole deadline saying nothing. Giving up in
    /// the middle of that silence releases nothing, because nothing is held; all
    /// it does is open the curtain in time for the echo to be shown raw.
    #[test]
    fn silence_after_the_write_is_not_a_host_refusing_the_line() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        assert_eq!(
            c.deadline(),
            Some(now + HOLD_CAP),
            "nothing has been said, so there is no host-side clock to run"
        );

        // The host's terminal driver echoes the line back at the instant of the
        // write, complete, with no shell involved. That is not the host
        // answering, and a clock started on it is a clock started on the write.
        assert_eq!(c.feed(now, &echoed(SETUP)), Emit::Nothing, "ours to hold");
        assert_eq!(
            c.deadline(),
            Some(now + HOLD_CAP),
            "our own line coming back is not a word from the host"
        );

        // Three seconds of a shell sourcing its rc, well past the old deadline,
        // and then the shell arrives and draws a prompt.
        let woke = now + CLEAR_DEADLINE + Duration::from_millis(500);
        assert_eq!(c.feed(woke, ZSH_PROMPT), Emit::Nothing, "a prompt, not a clear");
        assert_eq!(
            c.deadline(),
            Some(woke + CLEAR_DEADLINE),
            "and now it runs, from the first word the host said"
        );
        match c.feed(woke, b"\x1b[H\x1b[2JMOTD\r\n$ ") {
            Emit::Bytes(b) => {
                let seen = String::from_utf8_lossy(&b).into_owned();
                assert!(!seen.contains("BASH_VERSION"), "showed the line: {seen}");
                assert!(seen.ends_with("MOTD\r\n$ "));
            }
            Emit::Nothing => panic!("the clear arrived, so the screen should have gone out"),
        }
    }

    /// And the limit on that: a host that takes the line and never says a word
    /// is held for the cap and no longer.
    #[test]
    fn a_host_that_says_nothing_at_all_is_still_let_go_at_the_cap() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        let much_later = now + HOLD_CAP + Duration::from_millis(1);
        match c.feed(much_later, b"> ") {
            Emit::Bytes(b) => assert_eq!(b, b"> ".to_vec()),
            Emit::Nothing => panic!("the cap passed; the pane must not stay empty"),
        }
        assert!(!c.is_holding());
    }

    /// The limit on the other side. A redraw is a short interruption; anything
    /// longer is the host, and the host's own words must not be taken off the
    /// screen on the strength of a few characters that look like ours.
    #[test]
    fn a_gap_too_long_to_be_a_redraw_ends_the_line() {
        let mut buf = SETUP[..40].to_vec();
        let host = "-- the host had something to say ".repeat(4);
        buf.extend_from_slice(host.as_bytes());
        buf.extend_from_slice(&SETUP[40..]);
        assert!(host.len() > REDRAW_SLACK, "the gap has to be past the limit");

        let e = find_echo_from(&buf, SETUP, 0).expect("the anchor is at the front");
        assert_eq!(e.matched, 40, "the walk stops where the line stops");
        let left = String::from_utf8_lossy(&strip_echo(&buf, SETUP)).into_owned();
        assert!(
            left.starts_with(&host),
            "the host keeps every word of its own: {left}"
        );
    }
    /// The bug this build exists for, in one line. zsh erases to the end of the
    /// display before it draws a prompt, which is its own ground and not the
    /// screen, and it used to be where the cut was made.
    #[test]
    fn a_prompt_that_erases_is_not_a_clear() {
        assert_eq!(
            find_erase(ZSH_PROMPT),
            None,
            "the erase in a prompt is the shell clearing under its own cursor"
        );
        assert!(
            find_erase(ZSH_CLEAR).is_some(),
            "and the one in a clear is the screen"
        );
    }

    /// The tolerance that made the bug possible is kept, and it is kept the way
    /// it was meant to be: `vt100`, `linux` and `ansi` all clear by homing and
    /// erasing forwards, and a home in front is what makes that a whole screen.
    #[test]
    fn a_clear_that_homes_and_erases_forwards_is_still_a_clear() {
        assert_eq!(find_erase(b"\x1b[H\x1b[J"), Some(3));
        assert_eq!(find_erase(b"\x1b[;H\x1b[0J"), Some(4));
        assert_eq!(find_erase(b"\x1b[1;1H\x1b[J"), Some(6));
        assert_eq!(
            find_erase(b"\x1b[24m\x1b[J"),
            None,
            "erasing forwards from where the cursor happened to be is not a clear"
        );
    }

    /// And the first erase is not blindly the answer either: a login has a
    /// prompt in it before it has a clear.
    #[test]
    fn the_clear_is_found_behind_a_prompt_that_erased_first() {
        let mut buf = ZSH_PROMPT.to_vec();
        let at = buf.len() + 3;
        buf.extend_from_slice(b"\x1b[H\x1b[J");
        assert_eq!(find_erase(&buf), Some(at));
    }

    /// A whole zsh login, in the order the bytes really arrive: the terminal
    /// driver's echo at the instant of the write, three seconds of `.zshrc`,
    /// the shell's prompt, its redraw of the line, and then the clear.
    ///
    /// Before this build the cut was made at the prompt and 1370 bytes went to
    /// the pane with `__omni_precmd` in them.
    #[test]
    fn the_first_screen_of_a_zsh_login_is_one_paint() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        assert_eq!(c.feed(now, &echoed(SETUP)), Emit::Nothing, "the driver");
        let woke = now + Duration::from_secs(3);
        assert_eq!(c.feed(woke, ZSH_PARTIAL_LINE), Emit::Nothing, "still ours");
        assert_eq!(c.feed(woke, ZSH_PROMPT), Emit::Nothing, "not a clear");
        assert_eq!(c.feed(woke, &redrawn(SETUP, 80, 6)), Emit::Nothing, "the shell");
        let mut last = ZSH_CLEAR.to_vec();
        last.extend_from_slice(b"MOTD\r\nLast login: Fri Aug 28 from 10.0.0.1\r\n");
        match c.feed(woke, &last) {
            Emit::Bytes(b) => {
                let seen = String::from_utf8_lossy(&b).into_owned();
                assert!(!seen.contains("BASH_VERSION"), "showed the line: {seen}");
                assert!(!seen.contains("omni_precmd"), "showed the line: {seen}");
                assert!(seen.starts_with("\u{1b}[H\u{1b}[2J"), "starts at the top");
                assert!(seen.ends_with("Last login: Fri Aug 28 from 10.0.0.1\r\n"));
            }
            Emit::Nothing => panic!("the clear arrived; the screen should have gone out"),
        }
        assert!(!c.is_holding());
    }

    /// The line comes back twice, so taking out the first copy is taking out
    /// half of it.
    #[test]
    fn every_copy_of_our_line_is_taken_out_and_not_just_the_first() {
        let mut buf = echoed(SETUP);
        buf.extend_from_slice(b"root@fw-01# ");
        buf.extend_from_slice(&redrawn(SETUP, 80, 12));
        let left = String::from_utf8_lossy(&strip_echo(&buf, SETUP)).into_owned();
        assert!(!left.contains("BASH_VERSION"), "left a copy behind: {left}");
        assert!(!left.contains("clear; cat"), "left a copy behind: {left}");
        assert!(
            left.contains("root@fw-01#"),
            "and kept every word the host said: {left}"
        );
    }

    /// An echo arriving a few bytes at a time is still our line, before there is
    /// enough of it to recognise as one. Without this the clock starts on the
    /// first fragment, which is the write again.
    #[test]
    fn an_echo_too_short_to_recognise_is_still_not_the_host_talking() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        for chunk in echoed(SETUP).chunks(5) {
            assert_eq!(c.feed(now, chunk), Emit::Nothing);
            assert_eq!(
                c.deadline(),
                Some(now + HOLD_CAP),
                "still nothing but our own line, a piece at a time"
            );
        }
    }

    /// The backstop. A host that clears its own screen in its rc file, between
    /// our write and our clear, has the cut made in the wrong place, and what
    /// follows a wrong cut is the shell's redraw of our line. Nobody sees it
    /// even so, because what leaves here leaves without our line in it whichever
    /// way it left.
    #[test]
    fn a_cut_made_in_the_wrong_place_still_shows_nobody_our_line() {
        let mut c = Curtain::new(FirstScreen::Curtained);
        let now = t0();
        c.setup_sent(now, SETUP);
        assert_eq!(c.feed(now, &echoed(SETUP)), Emit::Nothing);
        let mut theirs = b"\x1b[H\x1b[2J".to_vec();
        theirs.extend_from_slice(&redrawn(SETUP, 80, 6));
        theirs.extend_from_slice(b"\x1b[H\x1b[2Jready\r\n");
        match c.feed(now, &theirs) {
            Emit::Bytes(b) => {
                let seen = String::from_utf8_lossy(&b).into_owned();
                assert!(!seen.contains("BASH_VERSION"), "showed the line: {seen}");
                assert!(!seen.contains("omni_precmd"), "showed the line: {seen}");
                assert!(seen.ends_with("ready\r\n"));
            }
            Emit::Nothing => panic!("an erase arrived; the screen should have gone out"),
        }
    }
}
