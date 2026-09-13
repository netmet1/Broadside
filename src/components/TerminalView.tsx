import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ArrowDownIcon, Loader2Icon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  onPtyClosed,
  onPtyData,
  ptyClose,
  ptyOpen,
  ptyResize,
  ptyWrite,
  type PtyOpenResult,
} from "@/lib/tauri/pty";
import { ptyOpenLocal } from "@/lib/tauri/local";
import {
  SESSION_PREFS_EVENT,
  describeIdle,
  loadSessionPrefs,
} from "@/lib/sessionPrefs";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  dismissShellWarning,
  shellNotice,
  shellWarningDismissed,
} from "@/lib/shells";
import type { SearchOptions } from "@/lib/search";
import { copyTerminalSelection } from "@/lib/terminalClipboard";
import { useReachability } from "@/lib/useReachability";
import { useHint } from "@/lib/status";
import { useTerminalFontZoom } from "@/lib/terminalZoom";
import { useUiPrefs } from "@/lib/uiPrefs";
import { cn } from "@/lib/utils";

/** Read the clipboard and send it to `sessionId` as if it had been typed, then
 * flash a short confirmation. Both paste routes (a right-click with nothing
 * selected, and Ctrl+Shift+V) go through here so they say the same thing. A
 * paste into a live shell is consequential (a trailing newline runs what went
 * in) and right-click is easy to press by accident, so the toast reports the
 * line count when there is more than one line: that is the case where the
 * clipboard held more than you thought and several commands just ran.
 * Nothing is said when the clipboard is empty or unreadable, or when the
 * session is gone and the text went nowhere. */
function pasteToSession(sessionId: string) {
  navigator.clipboard
    ?.readText()
    .then((text) => {
      if (!text) return;
      const lines = text.replace(/\r?\n$/, "").split("\n").length;
      ptyWrite(sessionId, text)
        .then(() =>
          toast.success(
            lines > 1 ? `Pasted ${lines} lines from clipboard` : "Pasted from clipboard",
            { duration: 1200 },
          ),
        )
        .catch(() => {});
    })
    .catch(() => {
      // Clipboard unreadable (empty or permission denied), ignore.
    });
}

export type ConnectionGate = Extract<
  PtyOpenResult,
  { status: "unknown_key" } | { status: "key_mismatch" }
>;

/** Imperative search surface for the Terminals page's Find bar (D-015:
 * PTY tabs are Find-only). */
export type TerminalSearchHandle = {
  findNext: (pattern: string, options: SearchOptions, incremental: boolean) => void;
  findPrevious: (pattern: string, options: SearchOptions) => void;
  clearSearch: () => void;
  focusTerminal: () => void;
};

/** xterm colours pulled from the theme-aware CSS variables (S1) so the terminal
 * matches the app theme and the pane container. */
function readTerminalTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--terminal-bg", "#0a0a0a"),
    foreground: v("--terminal-fg", "#e5e5e5"),
    cursor: v("--terminal-cursor", "#e5e5e5"),
    selectionBackground: v("--terminal-selection", "#3b82f680"),
  };
}

/** How Find paints its matches, from the same theme-aware CSS variables the
 * terminal colours come from.
 *
 * These are opaque on purpose. xterm's DOM renderer applies a decoration by
 * overriding the cell's background colour and drops the alpha channel doing it,
 * so a translucent value would be silently flattened against black.
 *
 * The active match is mostly drawn by the terminal's own selection, which
 * findNext sets and which paints over a decoration. Its decoration still earns
 * its place: it is the only handle the addon has on which of the matches is the
 * active one, so without it there is a count but no `3 of 17`.
 *
 * The overview-ruler colours are required by the addon's type but land nowhere:
 * the ruler is only built when the `overviewRuler` terminal option carries a
 * width, and nothing here sets one. */
function readSearchDecorations() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  const match = v("--terminal-search-match", "#5c4a00");
  const activeMatch = v("--terminal-search-active", "#9a7d00");
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: activeMatch,
    activeMatchBorder: v("--terminal-search-active-border", "#ffcc33"),
    activeMatchColorOverviewRuler: activeMatch,
  };
}

/**
 * Terminal state a dead session could have left switched on, switched back off.
 *
 * A program that owns the screen turns things on at the terminal and turns them
 * off again when it exits. A session that is killed while one is running never
 * reaches the second half, and the modes belong to the pane rather than to the
 * connection, so the *next* session inherits them.
 *
 * The mouse is the one that bites. htop asks for mouse reporting; kill the
 * session while it is up and reconnect, and the first turn of the scroll wheel
 * sends `ESC[<64;25;34M` at a bash prompt that never asked for it. Readline eats
 * the escape prefix and runs the rest, so the pane fills with `64: command not
 * found` and the shell is unusable until the tty is thrown away (smoke 60-4 D5).
 * Every protocol and encoding xterm.js knows is named, because we do not know
 * which one the dead program picked.
 *
 * `ESC[!p` is DECSTR, a soft reset, and covers the rest of it in four bytes:
 * attributes, charsets, scroll margins, origin mode, autowrap, application
 * cursor keys and keypad, bracketed paste, and the cursor made visible again.
 * It is deliberately not `ESC c`, which in xterm.js throws the scrollback away,
 * and it does not touch the mouse, which is why the line above exists.
 */
const CLEAR_STICKY_MODES =
  "\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016l\x1b[!p";

/** The rule the session divider is drawn with: U+2501, single width. */
const DIVIDER_RULE = "━";

/** `14:02:11`. Local, 24-hour, built by hand rather than left to
 * `toLocaleTimeString`, which renders midnight as `24:00:00` under some
 * hour-cycle settings. */
function clockTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The escape sequence that hands a reconnect a clean screen: the modes above
 * reset, whatever the old session left on screen pushed up into the scrollback
 * with a divider under it, and the cursor at the top of a blank one.
 *
 * The pane keeps a dead session's output on purpose, and on a host that takes
 * Broadside's setup line that goes unnoticed, because the `clear` in the line
 * wipes the screen a moment later. A host we send nothing to (a console menu on
 * an appliance, pfSense's `rc.initial`) has no such clear, so its menu printed
 * directly underneath the old copy and the pane read as having drawn it twice.
 *
 * Line feeds rather than an erase, because nothing here is worth throwing away:
 * everything the old session printed is still there to scroll back to, which is
 * more than a Linux host's own `clear` leaves behind (it ends in `ESC[3J`, which
 * drops the scrollback outright). Exactly as many as there are used rows, so a
 * short screen does not bury itself under blank ones on the way up.
 *
 * `endedAt` is when the old session ended, and null when there was no old
 * session (a first connect coming back through here after a host-key dialog).
 * With one, a stack of reconnects on the same tab reads as a stack rather than
 * a run-on, because each screen has a line under it saying when it stopped.
 */
function freshScreenSequence(term: Terminal, endedAt: number | null): string {
  // A session that died inside a full-screen program (less, htop, an installer)
  // left the pane on the alternate screen, which has no scrollback to push
  // anything into and would swallow the new session's output as well. Measure
  // the normal buffer, which is the one that keeps the scrollback and the one
  // we are about to come back to.
  const alternate = term.buffer.active.type === "alternate";
  const buf = alternate ? term.buffer.normal : term.buffer.active;
  let used = 0;
  for (let y = 0; y < term.rows; y++) {
    if (buf.getLine(buf.baseY + y)?.translateToString(true)) used = y + 1;
  }
  let out = (alternate ? "\x1b[?1049l" : "") + CLEAR_STICKY_MODES;
  // An empty screen still gets homed: the cursor can be sitting anywhere, and
  // the new session should start at the top rather than wherever the old one
  // stopped. Nothing to divide, either.
  if (used === 0) return out + "\x1b[H";

  const bottomRow = `\x1b[${term.rows};1H`;
  // A line feed on the bottom row is what moves a line into the scrollback, so
  // one per used row takes the whole screen with it.
  out += bottomRow + "\n".repeat(used);
  // Then the divider, written across the top of the now-blank screen and sent
  // after it the same way. Three rows, so a pane too short to hold them without
  // scrolling mid-write goes without; nothing that small is readable anyway.
  if (endedAt !== null && term.rows >= 3) {
    const rule = DIVIDER_RULE.repeat(term.cols);
    out +=
      // Dim, because this is Broadside talking in the middle of the host's
      // output and it should read as a margin note rather than as something
      // the host said.
      `\x1b[H\x1b[2m${rule}\r\n[SESSION DISCONNECTED: ${clockTime(endedAt)}]\r\n${rule}\x1b[0m` +
      bottomRow +
      "\n\n\n";
  }
  return out + "\x1b[H";
}

/** How often an open pane checks whether it has gone quiet.
 *
 * Five seconds against a timeout measured in minutes: the check is a
 * subtraction, and the cost of being up to five seconds late closing a session
 * that has been idle for half an hour is nothing at all. */
const IDLE_CHECK_MS = 5_000;

type Phase =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "gate"; gate: ConnectionGate }
  | { kind: "failed"; message: string }
  /** `clean` is how the session ended, not whether it ended: a shell that was
   * asked to go and went is clean, and a shell that died on its own or came
   * back non-zero is not. It only tints the message on the banner, so a wrong
   * guess costs a colour rather than a behaviour. */
  | {
      kind: "closed";
      message: string;
      clean: boolean;
      /** This pane was closed by the idle timeout rather than by the shell or
       * the operator. The banner says so in amber and links to the setting,
       * because a terminal that closed itself while you were in a meeting is
       * otherwise indistinguishable from one that dropped. */
      idle?: boolean;
    };

/** How long a connect may take before the overlay says which half is slow.
 *
 * Under this, the operator sees the spinner and the word and nothing else,
 * which is the whole of what a connect that lands needs. Over it, the wait is
 * long enough to be worth a sentence, and the sentence differs: waiting on the
 * host to answer at all is a different problem from waiting on it to finish
 * logging you in, and only one of those is the network's fault. */
const SLOW_CONNECT_MS = 4000;

/** How long the overlay will wait for the first bytes of a session that has
 * already been granted a shell.
 *
 * The backend holds a session's first screen until the host has finished
 * drawing it, capped at ten seconds (see `ssh/connect_curtain.rs`), and a
 * curtain that lifts with nothing to show sends no frame at all. So this is
 * that cap plus the slack in front of it, and it exists for the host that never
 * says anything: without it the overlay would sit over an empty pane for the
 * life of the tab. Past it the overlay comes down and the pane is the pane,
 * empty or not.
 *
 * Longer than the wait it is backing, on purpose. Cutting a curtain off early
 * would put the overlay down a moment before the login screen it was covering
 * arrives, which is a flicker of exactly the kind this build removed. */
const FIRST_PAINT_GRACE_MS = 13000;

/** How far along a pane's connection is, without the message that goes with it.
 * Reported to the page (see `onPhaseChange`) because "not connected" is four
 * different situations and only two of them are worth retrying: a pane that is
 * still `connecting` has a connect in flight that a retry would tear down, and
 * one at a `gate` is waiting on a host-key dialog the operator has to answer
 * either way. `failed` and `closed` are the ones showing a Try again button. */
export type TerminalPhaseKind = Phase["kind"];

/** What to say about a connect that has been going a while.
 *
 * Two answers rather than one, because the halves of a slow connect have
 * different culprits and the difference is something the operator can act on:
 * nothing has answered yet is a link or a machine that is down, and a login
 * already accepted but not yet drawn is neither of those. */
function slowConnectNote(kind: TerminalPhaseKind, local: boolean): string {
  if (kind === "connecting") {
    return local
      ? "Still waiting for the shell to start."
      : "Still waiting for the host to accept the connection.";
  }
  // Only a remote pane reaches here. An open one is covered only while its
  // first screen is being held, and nothing holds a local shell's.
  return "Signed in. Waiting for the host to finish drawing the login screen.";
}

/** What backs this terminal: an SSH host, or a local shell over ConPTY. A local
 * source may carry a saved profile's `cwd` (passed to the spawn) and
 * `startupCommand` (typed into the shell once it opens). */
export type TerminalSource =
  | { type: "ssh"; hostId: number }
  | { type: "local"; shellId: string; cwd?: string; startupCommand?: string };

type Props = {
  sessionId: string;
  source: TerminalSource;
  /** Whether this terminal's tab AND the Terminals page are visible. */
  visible: boolean;
  /** Bumps when the user resolves a TOFU gate, triggers a reconnect. */
  retryNonce: number;
  /** Bumped to re-initialize the xterm view, for recovering a display a
   * full-screen program left garbled (alternate screen, a stray scroll region,
   * a half-drawn dialog with escape sequences smeared over it). Local only: it
   * clears this pane's buffer and scrollback, the remote is untouched and keeps
   * running. */
  resetNonce: number;
  /** Bumped to end this session on purpose while keeping the tab (the unplug
   * button in the Sessions menu). Closes the shell and drops the pane into its
   * closed phase, which is the same place typing `exit` leaves it: the buffer
   * stays readable and the banner offers Reconnect or Close tab. */
  endNonce: number;
  onGate: (sessionId: string, gate: ConnectionGate) => void;
  onClosed: (sessionId: string) => void;
  /** Re-open the PTY on this same session id (Reconnect button on the closed
   * banner). Bumps the parent's retry nonce, which re-runs the connect effect. */
  onReconnect: (sessionId: string) => void;
  /** Ctrl+F pressed while the terminal has focus. */
  onSearchRequest: () => void;
  /** Alt+Left/Right pressed while the terminal has focus, switch tabs. */
  onTabNav: (dir: "prev" | "next") => void;
  /** Live match feedback from the search addon. A `resultCount` of -1 is not a
   * count at all: it says the search threw and there is no answer, which the
   * Find bar must show as a failure rather than as an empty result. */
  onSearchResults: (resultIndex: number, resultCount: number) => void;
  /** Fires whenever this session's live-connection state flips (used for
   * the Hosts page connected indicators). */
  onConnectionChange?: (sessionId: string, connected: boolean) => void;
  /** Fires with the same transitions as `onConnectionChange`, but says which of
   * the not-connected states this is. The page needs the distinction for Retry
   * all: `connecting` and `gate` are both "red" in the tab strip and neither
   * wants a retry. */
  onPhaseChange?: (sessionId: string, phase: TerminalPhaseKind) => void;
  /** Open Settings at the session section, from the amber line the banner
   * shows when the idle timeout is what closed this pane. */
  onOpenSessionSettings?: () => void;
  /** Adopt a backend PTY that is already open (a skill run handed its shell
   * over) instead of opening a new one. Skips `pty_open` on the first mount and
   * binds to the existing session id; a later Reconnect opens for real. */
  adoptExisting?: boolean;
  /** The skill pane's scrollback as an ANSI string, written into this terminal
   * once on the adopting mount so the run's history is visible (adoption binds
   * to the live stream going forward; the backend does not replay the past). */
  adoptSnapshot?: string;
  /** Mount without connecting: the pane goes straight to the closed banner and
   * waits on Reconnect.
   *
   * What a template set to "open the tabs at startup" opens with, so an
   * unattended launch makes no connections of its own. It reuses the closed
   * phase rather than inventing a fourth not-connected state, which means the
   * pane already has the button, the reachability pill and the wording for
   * "there is no shell here yet"; the only thing that differs is that there
   * never was one. First mount only: Reconnect bumps the retry nonce, and from
   * there this connects like any other pane. */
  startClosed?: boolean;
};

/** One xterm.js pane bound to one backend PTY session. Stays mounted (and
 * connected) while hidden so sessions survive page/tab switches. */
export const TerminalView = forwardRef<TerminalSearchHandle, Props>(
  function TerminalView(
    {
      sessionId,
      source,
      visible,
      retryNonce,
      resetNonce,
      endNonce,
      onGate,
      onClosed,
      onReconnect,
      onSearchRequest,
      onTabNav,
      onSearchResults,
      onConnectionChange,
      onPhaseChange,
      onOpenSessionSettings,
      adoptExisting,
      adoptSnapshot,
      startClosed,
    }: Props,
    searchHandleRef,
  ) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The whole pane, which is the terminal plus whatever is overlaid on it. The
  // banners and the connecting overlay are siblings of the terminal container
  // rather than children, so a listener on the container alone stops at their
  // edges: Ctrl+wheel over the disconnected banner did nothing.
  const paneRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // Resolves once the pty:data listener is actually registered. The connect
  // effect awaits this before opening so a shell that emits immediately (e.g.
  // PowerShell's startup cursor-position query, which it blocks on) isn't missed.
  const dataReadyRef = useRef<Promise<unknown> | null>(null);
  // Guards the one-time write of an adopted session's scrollback snapshot.
  const snapshotWrittenRef = useRef(false);
  // A reconnect is waiting to start on a clean screen. Armed when the connect
  // effect re-runs, spent by the first bytes of the new session, which is the
  // moment that matters: doing it when Reconnect is pressed would blank the
  // pane for the whole connect and take away the output the operator is
  // probably still reading. See freshScreenSequence.
  const freshScreenRef = useRef(false);
  // When the session on screen ended, for the divider the next reconnect draws
  // under it. Only a close sets it, not a failed connect: a reconnect that
  // fails leaves the same dead screen sitting there, and the time worth
  // stamping on it is still the one it stopped at. Null means nothing has ended
  // in this pane, which is the host-key-dialog case (a first connect arriving
  // through the same code path, with an empty screen and nothing to divide).
  const endedAtRef = useRef<number | null>(null);
  // Deadline (performance.now) until which a leading `^L` arriving from the
  // shell is the echo of our own Reset display form feed and is dropped before
  // it is drawn. Armed by the reset effect below, disarmed by the first hit.
  // Zero means not armed.
  const swallowEchoUntilRef = useRef(0);
  // Whether this pane has pixels on screen, per the IntersectionObserver in
  // the setup effect. It mirrors the private flag xterm keeps for pausing its
  // renderer, because both observers watch the same box. `fit()` must never
  // run while this is false: see the observer for what a fit against a paused
  // renderer does to the viewport. Starts true because the renderer also
  // starts unpaused, and only ever goes false once an observer says so.
  const intersectingRef = useRef(true);
  const onSearchRequestRef = useRef(onSearchRequest);
  onSearchRequestRef.current = onSearchRequest;
  const onTabNavRef = useRef(onTabNav);
  onTabNavRef.current = onTabNav;
  const onSearchResultsRef = useRef(onSearchResults);
  onSearchResultsRef.current = onSearchResults;
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;
  const onPhaseChangeRef = useRef(onPhaseChange);
  onPhaseChangeRef.current = onPhaseChange;
  const { prefs } = useUiPrefs();
  // Ctrl + wheel over this pane resizes the terminal text (unless Strict is set
  // in Settings). The size change lands back in `prefs`, so the effect below
  // applies it here and in every other open pane.
  useTerminalFontZoom(paneRef);
  const { resolvedTheme } = useTheme();
  // Read once at terminal creation; live changes are applied by the
  // prefs effect below without recreating the terminal.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const phaseRef = useRef<Phase>({ kind: "connecting" });
  const [phase, setPhaseState] = useState<Phase>({ kind: "connecting" });
  // An unsupported login shell reported by the open (X4), or null. Held apart
  // from `phase` because it survives across the phase transitions of a
  // reconnect and is cleared only by the operator dismissing it.
  const [shellWarning, setShellWarning] = useState<{
    /** The verdict this strip is for, and what a dismissal is remembered
     * against, from `shellNotice`. */
    key: string;
    message: string;
  } | null>(null);
  const setPhase = useCallback(
    (p: Phase) => {
      if (p.kind === "closed") endedAtRef.current = Date.now();
      phaseRef.current = p;
      setPhaseState(p);
      onConnectionChangeRef.current?.(sessionId, p.kind === "open");
      onPhaseChangeRef.current?.(sessionId, p.kind);
    },
    [sessionId],
  );
  // Nothing has reached this pane yet on this connect.
  //
  // Not the same thing as the `connecting` phase, and the gap between them is
  // the reason this exists: `pty_open` returns as soon as the host grants a
  // shell, so the pane goes `open` while the first screen is still being held
  // back on the Rust side. Before this, the overlay came down at that moment
  // and the rest of the wait happened on a blank pane, with nothing on screen
  // to say anything was still going on. The ref is what the data callback
  // compares against so the state is set once and not once per chunk.
  const unpaintedRef = useRef(true);
  const [unpainted, setUnpainted] = useState(true);
  // The first-paint wait has run out (see FIRST_PAINT_GRACE_MS). Only ever
  // about the window after the shell is granted; a pane still `connecting` is
  // covered for as long as it takes.
  const [firstPaintGaveUp, setFirstPaintGaveUp] = useState(false);
  // The connect has been going long enough to say more about it.
  const [slowConnect, setSlowConnect] = useState(false);
  // Whether this pane is parked above the live end of its output, which is the
  // only time the jump-to-bottom button is drawn. The ref is the one the
  // terminal's own events compare against; the state is only what renders.
  const scrolledUpRef = useRef(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const hint = useHint();

  // Is the host back yet? Asked only while this pane sits on its Reconnect
  // button, and only for a remote one: a local shell has no host to be waiting
  // for, and the closed banner on a ConPTY tab means the program exited.
  const reachability = useReachability(
    source.type === "ssh" ? source.hostId : null,
    phase.kind === "closed" && source.type === "ssh",
  );

  // Create the terminal once.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: prefsRef.current.terminalFontFamily,
      fontSize: prefsRef.current.terminalFontSize,
      cursorBlink: true,
      theme: readTerminalTheme(),
      scrollback: prefsRef.current.terminalScrollback,
      // Find needs it. `registerDecoration` is still behind xterm's proposed-API
      // gate, and the search addon calls it for every match it highlights; with
      // the gate shut the call throws, which is why the Find bar could never say
      // how many matches there were (see findNext below).
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    if (containerRef.current) term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    const resultsSub = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      onSearchResultsRef.current(resultIndex, resultCount);
    });

    // Scrolled-up detection, for the jump-to-bottom button below.
    //
    // Deliberately not the shared ScrollToBottom component, which the Broadcast
    // pages use. That one watches a real scrolling element with a
    // MutationObserver over its whole subtree, which is exactly right for a log
    // built out of DOM nodes and exactly wrong here: xterm rewrites its rows on
    // every frame of output, so a subtree observer on a wall of live terminals
    // would be re-measuring all of them continuously. xterm knows the answer
    // already, so ask it.
    //
    // Two events, because either alone leaves a case out: `onScroll` covers the
    // viewport moving, and `onWriteParsed` covers output arriving while it sits
    // still, which grows the distance to the bottom without any scrolling at
    // all. The ref is what keeps this from being a setState per frame.
    const updateScrolledUp = () => {
      const b = term.buffer.active;
      // A couple of rows of slack, so the button does not blink in and out at
      // the boundary while output is arriving.
      const next = b.baseY - b.viewportY > 2;
      if (next === scrolledUpRef.current) return;
      scrolledUpRef.current = next;
      setScrolledUp(next);
    };
    const scrollSub = term.onScroll(updateScrolledUp);
    const writeSub = term.onWriteParsed(updateScrolledUp);

    // Ctrl+F opens the Find bar instead of sending ^F to the remote shell.
    //
    // Returning false only tells xterm to keep its hands off the key; it does
    // NOT stop the webview acting on it. Every branch here therefore calls
    // preventDefault as well, or the browser's own handling runs on top of
    // ours, which is exactly what made Ctrl+Shift+V paste twice: we wrote the
    // clipboard to the PTY, then Chromium's paste-and-match-style fired a
    // `paste` event at xterm's hidden textarea and xterm wrote it again.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.ctrlKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        onSearchRequestRef.current();
        return false;
      }
      // Ctrl+Shift+C copies the current selection; Ctrl+Shift+V pastes. These
      // are the keyboard's half of the right-click, which copies a selection
      // and otherwise pastes. Ctrl+C/Ctrl+V alone stay reserved for the shell
      // (SIGINT / literal paste-through the shell may want). The copy clears
      // the selection, as the right-click does, so the two leave the pane in
      // the same state and the next right-click pastes.
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        e.preventDefault();
        copyTerminalSelection(term);
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
        e.preventDefault();
        pasteToSession(sessionId);
        return false;
      }
      // Alt+Left/Right switch terminal tabs even while the terminal is focused.
      // Intercept here so the shell never receives the escape sequence (and so
      // the webview doesn't treat Alt+Left/Right as back/forward navigation).
      if (
        e.type === "keydown" &&
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        // Stop the event bubbling to the window-level Alt+arrow handler in
        // TerminalsPage, otherwise both handlers fire for one keypress and the
        // tab index advances twice (skips every other tab).
        e.stopPropagation();
        onTabNavRef.current(e.key === "ArrowRight" ? "next" : "prev");
        return false;
      }
      return true;
    });

    const dataSub = term.onData((data) => {
      lastActivityRef.current = Date.now();
      ptyWrite(sessionId, data).catch(() => {
        // Session already gone; the closed event handles UI state.
      });
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      ptyResize(sessionId, cols, rows).catch(() => {});
    });

    // Whether the shell is holding the terminal or has handed it to a command,
    // for the idle timeout further down.
    //
    // Bracketed paste is the nearest thing to a shell saying "I am waiting for
    // you to type": readline and zsh's zle turn it on while a prompt is up and
    // off again before they give the terminal to a command, then back on at the
    // next prompt. That makes a silent `sleep 120` visible as work in progress
    // rather than as a quiet session, without asking anything of the host.
    //
    // Watched, not handled. Returning `false` puts the sequence back on the
    // parser's own chain, so the mode is still applied exactly as before.
    const noteBracketedPaste = (params: (number | number[])[], on: boolean) => {
      if (params.some((p) => p === 2004)) {
        if (on) promptRef.current.seen = true;
        promptRef.current.atPrompt = on;
      }
      return false;
    };
    const modeOnSub = term.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => noteBracketedPaste(params, true),
    );
    const modeOffSub = term.parser.registerCsiHandler(
      { prefix: "?", final: "l" },
      (params) => noteBracketedPaste(params, false),
    );

    // Refit coalesced to one per frame: a grid relayout (hiding a tile flips
    // the container between the 3+ grid and the two-up split, and a scrollbar
    // appearing or vanishing shifts widths again) can fire several resizes in
    // a burst, and ConPTY handles one clean resize far better than a storm of
    // them (each grow risks the prompt repainting mid-screen until the next
    // keystroke). If the viewport was pinned to the bottom before the refit,
    // re-pin it after, so the prompt stays where the resize leaves the cursor;
    // a viewport deliberately scrolled up into history is left alone.
    let refitRaf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(refitRaf);
      refitRaf = requestAnimationFrame(() => {
        if (!containerRef.current?.offsetParent) return;
        // A pane with no pixels on screen waits: the IntersectionObserver
        // below refits it the moment it has some. Fitting it now is the bug.
        if (!intersectingRef.current) return;
        const buf = term.buffer.active;
        const pinned = buf.viewportY >= buf.baseY;
        fit.fit();
        if (pinned) term.scrollToBottom();
      });
    });
    if (containerRef.current) observer.observe(containerRef.current);

    // The only gate through which a hidden pane comes back: refit it here, in
    // our own IntersectionObserver, and nowhere earlier.
    //
    // xterm pauses its renderer while the pane is off screen, and a paused
    // renderer defers the renderer half of a resize while its dimensions go on
    // reporting the pane's OLD box. Any `fit()` in that window plants a mine:
    // xterm's viewport clamps scroll offsets against the stale height (a
    // full-window tab, where a grid tile is now), the clamp is reported back
    // as though the operator had dragged the scrollbar, and the buffer is
    // hauled to the top of its scrollback. Worse, when the stale height
    // exceeds the buffer's own pixel height the scrollbar's range collapses to
    // nothing and the wheel goes dead, and every public scroll call routes
    // through that same collapsed scrollbar, so nothing can repair it from
    // out here (smoke 46-3: TG1 at the top of its history, wheel inert, until
    // an Enter forced output and output forced a fresh measure). The 46-3
    // build tried to out-wait the pause by counting frames; the pause ends in
    // xterm's own IntersectionObserver, which frame counting cannot order
    // against. This observer can: xterm registers its observer inside
    // `term.open()`, observers fire in creation order, and ours is created
    // after, so by the time this callback runs xterm has already woken the
    // renderer and re-measured the char size (which also covers a font change
    // applied while the pane was hidden). A fit here is a fit against live
    // dimensions, and every scroll sync that follows agrees with it.
    //
    // Smoke 52-3 section H reported a pane that "started to scroll to the
    // bottom by itself" on the way back, after an `ls -R` had been writing to
    // it for minutes while it was hidden, and was fine once it got there. Not
    // reproduced on a second attempt, and not diagnosed. What it is *not*, read
    // out of the xterm 6 sources we actually ship rather than guessed at:
    //
    //   - Not an animation. `smoothScrollDuration` defaults to 0 and we never
    //     set it, so every scroll xterm performs is a single assignment. The
    //     public `scrollToBottom()` takes no argument, so there is nothing to
    //     pass here to make that more true than it already is.
    //   - Not the renderer waking up. A paused RenderService records one
    //     `_needsFullRefresh` and repaints once on resume. One repaint.
    //   - Not a parse backlog. `WriteBuffer` reschedules itself with
    //     `setTimeout`, never a frame callback, so a hidden pane goes on
    //     parsing at the same rate a visible one does and cannot bank minutes
    //     of output.
    //   - Not our own batching. The DataPump's window is 4ms with a 256KB cap
    //     (ssh/pty.rs), so it cannot hold anything either.
    //
    // Both conditions it was seen under have since changed: that pane was
    // capped at xterm's 1000 lines and was trimming its buffer on every line,
    // and local shells now start in UTF-8. Worth re-running before looking
    // further, and worth capturing what the pane shows on arrival rather than
    // only that it moved.
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      intersectingRef.current = entry.isIntersecting;
      if (!entry.isIntersecting) return;
      const buf = term.buffer.active;
      const pinned = buf.viewportY >= buf.baseY;
      fit.fit();
      if (pinned) term.scrollToBottom();
    });
    if (containerRef.current) io.observe(containerRef.current);

    // The right-click (Windows Terminal's convention): with a selection it
    // copies and clears it, and with none it pastes, reading the clipboard and
    // sending it to the shell as if typed. So the mouse does both halves: select,
    // right-click to copy, right-click again where it should go.
    //
    // This replaced copy-on-select, which copied on every mouse-up. Selecting
    // was a clipboard write whether anyone wanted one or not, and a drag made
    // just to read a line threw away the command copied a minute earlier. Here
    // a selection is only ever copied when asked.
    //
    // Always suppresses the native context menu. A paste into a closed session
    // is a no-op (ptyWrite swallows the error), but a copy still works there,
    // which is how the last thing a dropped session printed gets out of it.
    //
    // Mouse-reporting programs (tmux or vim with the mouse on) take the drag
    // for themselves, as before; Shift-drag selects past them, and the
    // right-click then copies.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (copyTerminalSelection(term)) return;
      pasteToSession(sessionId);
    };
    const contextMenuEl = containerRef.current;
    contextMenuEl?.addEventListener("contextmenu", onContextMenu);

    // Everything the session says goes through here rather than to
    // `term.write` directly, so a reconnect's clean screen cannot be missed by
    // one of the two paths below.
    const writeToPane = (data: Uint8Array) => {
      // Output is activity too, and this is the one funnel every byte the
      // session says goes through. A broadcast typed into this PTY from another
      // page arrives here as output, so it keeps the session alive without the
      // idle timer needing to know that page exists.
      lastActivityRef.current = Date.now();
      // Whatever this is, the pane is no longer empty, so the overlay has
      // nothing left to explain.
      if (unpaintedRef.current) {
        unpaintedRef.current = false;
        setUnpainted(false);
      }
      if (freshScreenRef.current) {
        freshScreenRef.current = false;
        const endedAt = endedAtRef.current;
        endedAtRef.current = null;
        term.write(freshScreenSequence(term, endedAt));
      }
      term.write(data);
    };

    const unlistenData = onPtyData(sessionId, (bytes) => {
      // Reset display sent a form feed. If a command is running in the
      // foreground the shell is not reading its keyboard, so the tty echoes
      // that keystroke back as the two characters `^L` (see the reset effect).
      // Drop it on the way in, while it is still just bytes: the alternative is
      // painting it and then clearing it, which is a visible flash. Only a
      // chunk that *starts* with the echo, and only in the moment after the
      // button was pressed, so a command that prints a caret and an L of its
      // own keeps them. Seeing it also tells us the form feed is queued rather
      // than acted on, which is the more important half, see below.
      if (swallowEchoUntilRef.current) {
        if (performance.now() > swallowEchoUntilRef.current) {
          swallowEchoUntilRef.current = 0;
        } else if (bytes[0] === 0x5e && bytes[1] === 0x4c) {
          swallowEchoUntilRef.current = 0;
          // That echo is also proof the shell never read the form feed: a
          // shell at its prompt redraws, it does not echo. So the byte is
          // still sitting in the tty's line buffer, and when the command
          // finally ends the shell reads it and clears the screen out from
          // under everything the command just printed. (Verified: the shell
          // prints `survived`, draws its prompt, and only then acts on the
          // form feed with a `[H[2J` that wipes both.)
          //
          // So take it back. One ERASE byte deletes the last character in
          // that buffer, which is ours, and leaves anything typed ahead of it
          // alone. Nothing runs; the pane simply stays clear until the command
          // finishes and the shell prints its own next prompt.
          ptyWrite(sessionId, "\x7f").catch(() => {});
          const rest = bytes.subarray(2);
          if (rest.length) writeToPane(rest);
          return;
        }
      }
      writeToPane(bytes);
    });
    dataReadyRef.current = unlistenData;
    const unlistenClosed = onPtyClosed((closed) => {
      if (closed.session_id !== sessionId) return;
      // Accept the close during "connecting" too, a shell can die in the
      // gap before the open invoke resolves, and swallowing the event here
      // would leave a live-looking but dead terminal.
      if (
        phaseRef.current.kind === "open" ||
        phaseRef.current.kind === "connecting"
      ) {
        const detail =
          closed.message ??
          (closed.exit_code !== null
            ? `shell exited with code ${closed.exit_code}`
            : "connection closed");
        // A zero exit is the only thing here that went to plan. A message from
        // the backend is always a reason it should not have ended, and a close
        // with no exit code at all is a connection that went away rather than a
        // shell that left.
        setPhase({
          kind: "closed",
          message: detail,
          clean: closed.message == null && closed.exit_code === 0,
        });
      }
    });

    return () => {
      dataSub.dispose();
      resultsSub.dispose();
      resizeSub.dispose();
      modeOnSub.dispose();
      modeOffSub.dispose();
      scrollSub.dispose();
      writeSub.dispose();
      cancelAnimationFrame(refitRaf);
      observer.disconnect();
      io.disconnect();
      contextMenuEl?.removeEventListener("contextmenu", onContextMenu);
      unlistenData.then((fn) => fn());
      unlistenClosed.then((fn) => fn());
      term.dispose();
      ptyClose(sessionId).catch(() => {});
      onConnectionChangeRef.current?.(sessionId, false);
    };

  }, [sessionId, setPhase]);

  // Reset display: re-initialize the xterm view and refit. Recovers a pane a
  // full-screen program left in a state the shell won't clean up on its own,
  // typically after a dialog-drawing program (a debconf or needrestart prompt)
  // was interrupted, leaving its box and any escape sequences that got echoed
  // painted over the screen. Local only: the buffer and scrollback go, the
  // remote session is untouched and its next output renders into the fresh
  // view. Skips the first render (nonce 0) so mounting never clears a pane.
  useEffect(() => {
    if (resetNonce === 0) return;
    const clear = () => {
      termRef.current?.reset();
      if (containerRef.current?.offsetParent) fitRef.current?.fit();
      // Nothing left to be above: reset throws the scrollback away, so the
      // jump-to-bottom button would otherwise sit there over an empty pane
      // until the next write happened to fire its listener.
      scrolledUpRef.current = false;
      setScrolledUp(false);
    };
    clear();
    // The echoed ^L: hidden, and the form feed behind it taken back.
    //
    // The reset is followed by a form feed asking the shell to redraw its
    // prompt (see TerminalsPage). When a command is running in the foreground,
    // the shell is not reading its keyboard: the tty echoes the keystroke as
    // the two characters `^L` and queues the byte for whenever the shell gets
    // round to it. So the pane cleared and then grew a `^L` and nothing else,
    // which looks like the button half-worked. Worse, the queued byte is still
    // coming: when the command ends the shell reads it and clears the screen,
    // taking the command's own last output with it.
    //
    // Both are handled in the data listener above, off the back of that echo:
    // the two characters are dropped before they are ever drawn, and the form
    // feed they came from is retracted with an ERASE so nothing is queued to
    // clear the screen later. That only catches the echo when it leads its
    // chunk, which is the normal case (it comes back on its own, ahead of
    // anything the command prints next).
    //
    // The sweep below is the fallback for when it does not: if a beat later
    // `^L` is the *entire* screen, it can only be the echo, so clear again. A
    // redrawn prompt, or a command still printing, leaves other text behind and
    // is left well alone. That path still shows the character for a moment,
    // which is the trade for a check this conservative.
    swallowEchoUntilRef.current = performance.now() + 1000;
    const sweep = setTimeout(() => {
      const term = termRef.current;
      if (!term) return;
      const buffer = term.buffer.active;
      const lines = Math.min(buffer.length, term.rows);
      let text = "";
      for (let i = 0; i < lines && text.length < 8; i++) {
        text += buffer.getLine(i)?.translateToString(true) ?? "";
      }
      if (text.trim() === "^L") clear();
    }, 350);
    return () => clearTimeout(sweep);
  }, [resetNonce]);

  // End this session on purpose, and keep the pane.
  //
  // The phase has to be set here rather than waited for, because a close asked
  // for through `pty_close` is a *deliberate* one and the backend deliberately
  // does not emit `pty:closed` for those (see ssh/pty.rs, local/mod.rs,
  // serial/mod.rs: a stray event there would fire on every tab close, after the
  // pane listening for it has gone). Every other caller of `ptyClose` is also
  // throwing the tab away, so nobody has needed the event; this one keeps the
  // tab, so it announces the close itself.
  //
  // Skips nonce 0 so mounting never kills the shell it just opened. Anything
  // not currently `open` is left alone: a pane mid-connect has an invoke in
  // flight that would race this, and one already closed or failed has nothing
  // to end and must keep the message it has, which says how it actually died.
  useEffect(() => {
    if (endNonce === 0) return;
    if (phaseRef.current.kind !== "open") return;
    ptyClose(sessionId).catch(() => {});
    // Clean by definition: this is the one close that was asked for from
    // inside the app, so there is nothing here for the banner to warn about.
    setPhase({
      kind: "closed",
      message: "session ended from the Sessions menu",
      clean: true,
    });
  }, [endNonce, sessionId, setPhase]);

  // Close this session when it has been quiet for long enough --------------
  //
  // Off unless the operator asks for it (see sessionPrefs). Idle means two
  // things, and both have to hold:
  //
  //   - no bytes in *either* direction, so a `tail -f` still printing is not
  //     idle even though nobody is typing at it. Keepalives are not traffic for
  //     this purpose: they are ours, sent whether anyone is here or not, and if
  //     they counted the timeout could never fire while the other setting was
  //     on.
  //   - nothing running in the foreground. A command that holds the terminal
  //     and says nothing for an hour (`sleep`, a long build, a restore) is the
  //     session doing exactly what it was asked to, and closing it is the one
  //     thing a timeout must never do. Something left running in the
  //     *background* does not count: the shell has the terminal back, and a
  //     `&` job cannot keep a session open forever on its own.
  //
  // SSH only. A local shell has no state table on a firewall somewhere to keep
  // alive and no connection to lose, so closing one would be taking something
  // away for nothing.
  const lastActivityRef = useRef(Date.now());
  /**
   * What this pane can tell about the shell's own state.
   *
   * `seen` stays false until the session enables bracketed paste even once. A
   * shell that never does (dash, an old bash, a device CLI) leaves no signal to
   * read, so the timeout falls back to quiet-alone rather than guessing; a
   * shell that does gives a reliable prompt-versus-command line all session.
   */
  const promptRef = useRef({ seen: false, atPrompt: false });
  const [idleSecs, setIdleSecs] = useState(() => loadSessionPrefs().idleSecs);
  useEffect(() => {
    const read = () => setIdleSecs(loadSessionPrefs().idleSecs);
    window.addEventListener(SESSION_PREFS_EVENT, read);
    return () => window.removeEventListener(SESSION_PREFS_EVENT, read);
  }, []);
  // A fresh shell has not been idle for anything, whatever this pane was doing
  // before it. Reconnect is the case that matters: without this, a tab that had
  // been sitting closed all afternoon would reconnect and immediately time out
  // again on the old clock.
  useEffect(() => {
    if (phase.kind === "open") {
      lastActivityRef.current = Date.now();
      // And it knows nothing about its shell yet either. Whatever the last one
      // was doing when it ended has nothing to say about this one.
      promptRef.current = { seen: false, atPrompt: false };
    }
  }, [phase.kind]);
  const isSsh = source.type === "ssh";
  useEffect(() => {
    if (idleSecs === null || !isSsh) return;
    const limitMs = idleSecs * 1000;
    /** Something has the terminal that is not the shell's own line editor. */
    const foreground = () => {
      // A full-screen program (vim, less, top, tmux) has the alternate buffer
      // and is plainly in the foreground, whatever it does with paste mode.
      if (termRef.current?.buffer.active.type === "alternate") return true;
      const p = promptRef.current;
      return p.seen && !p.atPrompt;
    };
    const timer = setInterval(() => {
      if (phaseRef.current.kind !== "open") return;
      // A command in the foreground holds the clock at zero rather than
      // pausing it, so when it finishes the session gets its whole timeout
      // from that moment, not whatever was left over from before it started.
      if (foreground()) {
        lastActivityRef.current = Date.now();
        return;
      }
      if (Date.now() - lastActivityRef.current < limitMs) return;
      // Same path the Sessions menu's unplug takes: close the PTY and announce
      // it here, because a close asked for from inside the app deliberately
      // emits no `pty:closed` (see the endNonce effect above).
      ptyClose(sessionId).catch(() => {});
      setPhase({
        kind: "closed",
        message: `idle for ${describeIdle(idleSecs)}`,
        clean: true,
        idle: true,
      });
    }, IDLE_CHECK_MS);
    return () => clearInterval(timer);
  }, [idleSecs, isSsh, sessionId, setPhase]);

  useImperativeHandle(searchHandleRef, () => ({
    findNext: (pattern, options, incremental) => {
      // The xterm search addon can throw on some inputs (smoke test 7.2:
      // the throw white-screened the app). Contain it here so a bad search
      // is a no-op, and log the stack for diagnosis rather than crashing.
      try {
        // `decorations` is what makes the addon count. It sweeps the whole
        // buffer for every match only when it has somewhere to paint them, and
        // onDidChangeResults returns early unless they are on, so a Find bar
        // without them can say nothing beyond "something was found" (T2, and
        // A4 on smoke 46-2: no `3 of 17`, so Up and Down were walking blind).
        //
        // They were off because they threw. Not the overview ruler, as the note
        // here used to say: the addon registers a decoration per match, and
        // `registerDecoration` is proposed API, which throws unless the terminal
        // was constructed with `allowProposedApi` (it now is). The catch below
        // swallowed it, so every search reported no matches at all.
        searchRef.current?.findNext(pattern, {
          regex: options.regex,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          incremental,
          decorations: readSearchDecorations(),
        });
      } catch (err) {
        console.error("[TerminalView] search findNext failed", err);
        // A count of -1 means "the search itself failed", not "nothing matched".
        // Reporting zero here is what hid the proposed-API throw above for as
        // long as it was hidden: a broken Find is indistinguishable from an
        // empty one, and every search politely said No matches.
        onSearchResultsRef.current(-1, -1);
      }
    },
    findPrevious: (pattern, options) => {
      try {
        searchRef.current?.findPrevious(pattern, {
          regex: options.regex,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          decorations: readSearchDecorations(),
        });
      } catch (err) {
        console.error("[TerminalView] search findPrevious failed", err);
        onSearchResultsRef.current(-1, -1);
      }
    },
    clearSearch: () => {
      try {
        searchRef.current?.clearDecorations();
        // findNext highlights the active match via the terminal SELECTION (no
        // decorations, they threw), so clearing decorations alone leaves that
        // selection lit until the user clicks away. Drop it now too.
        termRef.current?.clearSelection();
      } catch (err) {
        console.error("[TerminalView] clearSearch failed", err);
      }
    },
    focusTerminal: () => termRef.current?.focus(),
  }));

  // Connect (and reconnect after a TOFU gate is resolved).
  useEffect(() => {
    let cancelled = false;
    // Anything but the first connect is writing into a pane that already has a
    // screen in it. Arm the clean start here and let the first bytes spend it,
    // so a connect that never lands leaves the old output where it was.
    if (retryNonce > 0) freshScreenRef.current = true;
    // A reconnect is a new first screen, so it gets the overlay again.
    unpaintedRef.current = true;
    setUnpainted(true);
    // Pending profile startup-command injection (local shells), cleared if the
    // tab tears down or reconnects before it fires.
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      // Opened by a template that was told to make the tabs and stop there.
      // Only on the first mount: a Reconnect (retryNonce > 0) is the operator
      // asking for the shell, and from there this is an ordinary connect.
      if (startClosed && retryNonce === 0) {
        setPhase({
          kind: "closed",
          message: "not connected yet",
          clean: true,
        });
        return;
      }
      setPhase({ kind: "connecting" });
      if (containerRef.current?.offsetParent) fit.fit();
      // Make sure the pty:data listener is live before the backend can emit, so
      // no early output (e.g. a shell's startup cursor query) is dropped.
      await dataReadyRef.current;
      if (cancelled) return;
      // Adopted session: a skill run already opened this PTY and handed it over.
      // Opening it again would spin up a second shell and orphan the first, so
      // just bind to the live session (the data/resize/close listeners key on
      // the id) and mark it open. Only on the first mount, a later Reconnect
      // (retryNonce > 0) means the original shell is gone, so fall through to a
      // real open.
      if (adoptExisting && retryNonce === 0 && source.type === "ssh") {
        if (phaseRef.current.kind !== "closed") {
          // Seed the run's scrollback before marking open, so the operator lands
          // on the history they were just watching, not a blank shell. Once only:
          // the live stream takes over from here, and a re-run of this effect
          // must not stamp the backlog in again.
          if (adoptSnapshot && !snapshotWrittenRef.current) {
            snapshotWrittenRef.current = true;
            term.write(adoptSnapshot);
          }
          // Adoption is a pane that already has a session's history in it. It
          // is not waiting on a first screen and must not be told it is: the
          // run may be sitting at a prompt with nothing more to say until
          // somebody types.
          unpaintedRef.current = false;
          setUnpainted(false);
          setPhase({ kind: "open" });
          term.focus();
        }
        return;
      }
      try {
        // Local shells have no host-key trust or auth gate, just spawn and open.
        if (source.type === "local") {
          await ptyOpenLocal({
            sessionId,
            shellId: source.shellId,
            cwd: source.cwd,
            cols: term.cols,
            rows: term.rows,
          });
          if (cancelled) return;
          if (phaseRef.current.kind !== "closed") {
            setPhase({ kind: "open" });
            term.focus();
            // A profile's startup command: type it into the shell (with the
            // Enter a real keypress sends) once the shell is up. Deferred a beat
            // so it lands after the shell's own prompt rather than racing the
            // banner, and re-run on a Reconnect since the fresh shell needs it
            // again. Guarded by `cancelled` so a torn-down tab never writes.
            const startup = source.startupCommand?.trim();
            if (startup) {
              startupTimer = setTimeout(() => {
                if (cancelled) return;
                ptyWrite(sessionId, startup + "\r").catch(() => {});
              }, 513);
            }
          }
          return;
        }
        const result = await ptyOpen({
          sessionId,
          hostId: source.hostId,
          cols: term.cols,
          rows: term.rows,
        });
        if (cancelled) return;
        switch (result.status) {
          case "opened": {
            // Flag a login shell we can't fully drive, unless this host's
            // warning was already dismissed for the same verdict (X4). The
            // verdict is the probe's answer *as the override left it*, so
            // setting a host to Never is itself news worth a strip, and one
            // dismissed while the host was on Auto does not silence it.
            const notice = shellNotice(
              result.capability,
              result.integration,
              result.login_shell,
            );
            if (notice && !shellWarningDismissed(source.hostId, notice.key)) {
              setShellWarning({ key: notice.key, message: notice.message });
            }
            // A pty:closed for this session may have raced ahead of the
            // open result, don't resurrect a dead session.
            if (phaseRef.current.kind !== "closed") {
              setPhase({ kind: "open" });
              term.focus();
            }
            break;
          }
          case "unknown_key":
          case "key_mismatch":
            setPhase({ kind: "gate", gate: result });
            onGate(sessionId, result);
            break;
          case "auth_failed":
            setPhase({ kind: "failed", message: `Authentication failed: ${result.message}` });
            break;
          case "unreachable":
            setPhase({ kind: "failed", message: `Unreachable: ${result.message}` });
            break;
          case "no_credentials":
            setPhase({
              kind: "failed",
              message: "No credentials stored. Edit the host on the Hosts page.",
            });
            break;
        }
      } catch (e) {
        if (!cancelled) setPhase({ kind: "failed", message: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
      if (startupTimer) clearTimeout(startupTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, retryNonce]);

  // How long the pane may go on being held for a first screen that never
  // arrives. Armed only for the window this is about, and re-armed by a
  // reconnect through `unpainted`.
  useEffect(() => {
    if (phase.kind !== "open" || !unpainted) {
      setFirstPaintGaveUp(false);
      return;
    }
    const timer = setTimeout(
      () => setFirstPaintGaveUp(true),
      FIRST_PAINT_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [phase.kind, unpainted]);

  // Whether this connect has been going long enough to explain itself. Keyed on
  // the overlay rather than on the phase, so the clock runs across the handover
  // from connecting to a held first screen instead of restarting at it: that
  // handover is invisible to the operator and it is the same wait to them.
  //
  // The held-screen half is remote-only, because the thing it is covering is:
  // only an SSH session has a first screen held back. A local shell that says
  // nothing yet is not waiting on anything we know about, and one of them says
  // nothing on purpose. A serial console is silent until you press Enter, and
  // telling somebody it is still connecting while a live COM port waits for
  // that keypress would be a lie with a spinner on it.
  const connectOverlay =
    phase.kind === "connecting" ||
    (source.type === "ssh" &&
      phase.kind === "open" &&
      unpainted &&
      !firstPaintGaveUp);
  useEffect(() => {
    if (!connectOverlay) {
      setSlowConnect(false);
      return;
    }
    const timer = setTimeout(() => setSlowConnect(true), SLOW_CONNECT_MS);
    return () => clearTimeout(timer);
  }, [connectOverlay]);

  // Apply appearance-setting changes to the live terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (
      term.options.fontFamily !== prefs.terminalFontFamily ||
      term.options.fontSize !== prefs.terminalFontSize
    ) {
      term.options.fontFamily = prefs.terminalFontFamily;
      term.options.fontSize = prefs.terminalFontSize;
      // Only a pane with pixels on screen refits now. A hidden one is left
      // over- or under-sized until it returns, when the IntersectionObserver
      // in the setup effect refits it, against the char size xterm re-measures
      // on waking (a hidden pane measures the new font as nothing).
      if (intersectingRef.current && containerRef.current?.offsetParent) {
        fitRef.current?.fit();
      }
    }
  }, [prefs.terminalFontFamily, prefs.terminalFontSize]);

  // Scrollback, on its own and deliberately not folded into the block above.
  // Nothing about the geometry changes, so there is nothing to refit: xterm
  // resizes the buffer off the back of the option and the pane keeps its rows
  // and columns. It applies to a hidden pane as readily as a visible one for the
  // same reason. Raising it is free and keeps everything already held; lowering
  // it discards the oldest lines there and then, which is why the field that
  // sets it is behind a Save rather than applying as it is typed.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.scrollback !== prefs.terminalScrollback) {
      term.options.scrollback = prefs.terminalScrollback;
    }
  }, [prefs.terminalScrollback]);

  // Re-theme the live terminal when the app theme changes (S1). The CSS vars
  // recompute from the html class, so re-reading them gives the new colours.
  // Deferred to the next frame: next-themes flips the <html> class in its own
  // effect, and a deep child's effect runs *before* the provider's, so reading
  // the computed vars synchronously here would lag one switch behind (a live
  // terminal kept the previous theme). rAF runs after the class + style recalc.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      if (term) term.options.theme = readTerminalTheme();
    });
    return () => cancelAnimationFrame(raf);
  }, [resolvedTheme]);

  // Hand the keyboard to this pane when it becomes visible. The refit that
  // used to happen here (and the frame-counting that tried to re-pin the
  // viewport after it) moved to the IntersectionObserver in the setup effect,
  // which is the only place a fit is safe: this effect runs before xterm's
  // renderer has woken up, and a fit that early is what dragged returning grid
  // tiles to the top of their scrollback and killed their scroll wheel
  // (smoke 46-3, and the banner-instead-of-prompt bug before it).
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      if (phaseRef.current.kind === "open") termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div ref={paneRef} className="relative h-full w-full">
      {/* A hair of gutter so the first column is not printed against the wall.
          In a grid tile the terminal fills the tile's content box exactly, so
          without this the leftmost character sits on the border line and a
          full-width line reads as if it has been trimmed.

          On the container rather than on `.xterm`: the fit addon measures this
          element's computed width, which is its content box, so the padding is
          already discounted and the column count stays right; and everything
          xterm measures for itself (selection, mouse reporting, the cursor)
          keeps working against its own box, which has simply moved. The strip
          it uncovers is the pane's `--terminal-bg`, the same colour the
          terminal paints, so it reads as margin and not as a gap.

          A literal 2px, not `pl-0.5`: rem follows the app font size and a
          terminal cell does not, so a rem gutter would grow against text that
          had not moved. */}
      <div ref={containerRef} className="h-full w-full pl-[2px]" />
      {/* Back to the live end, for a pane you have scrolled up in.
          Ctrl+End does it and so does typing anything, but neither is
          discoverable, and reading something a thousand lines back and then
          hunting for the bottom with a wheel is the whole complaint.

          Drawn only while the pane is genuinely up in its scrollback, and only
          while a shell is actually there: a closed pane already has a banner
          along its bottom edge and does not need a second thing floating over
          it. Sits above that edge and inside the right margin, clear of both
          the banner and xterm's own scrollbar. */}
      {scrolledUp && phase.kind === "open" && (
        <button
          type="button"
          className="absolute bottom-4 right-6 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background/80 text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => {
            termRef.current?.scrollToBottom();
            termRef.current?.focus();
          }}
          aria-label="Scroll to the newest output"
          {...hint("Jump to the newest output in this pane.")}
        >
          <ArrowDownIcon className="h-4 w-4" />
        </button>
      )}
      {/* Connecting, and the two states that replace it. The connecting half
          takes no clicks: there is nothing in it to press, and letting them
          through means an operator can put the cursor in the pane and start
          typing at a shell that is already listening, which is what a blank
          pane used to let them do. Keystrokes were never blocked either way,
          the terminal keeps focus underneath. */}
      {(connectOverlay || phase.kind === "gate" || phase.kind === "failed") && (
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-center bg-background/85",
            connectOverlay && "pointer-events-none",
          )}
        >
          <div className="max-w-md space-y-3 px-6 text-center">
            {connectOverlay && (
              <>
                <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2Icon
                    className="h-4 w-4 shrink-0 animate-spin"
                    aria-hidden
                  />
                  Connecting…
                </p>
                {/* Only once the wait is long enough to be worth a sentence.
                    Which sentence depends on how far the connect got, and that
                    is the useful half: an operator who can see the login was
                    accepted knows to stop suspecting their network. */}
                {slowConnect && (
                  <p className="text-xs text-muted-foreground/80">
                    {slowConnectNote(phase.kind, source.type === "local")}
                  </p>
                )}
              </>
            )}
            {phase.kind === "gate" && (
              <>
                <p className="text-sm text-muted-foreground">
                  Waiting on host-key verification…
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onClosed(sessionId)}
                >
                  Close tab
                </Button>
              </>
            )}
            {phase.kind === "failed" && (
              <>
                <p className="text-sm text-red-400">{phase.message}</p>
                {/* Try again before Close tab: a failed connect is usually
                    transient (a busy sshd refusing a burst of handshakes is the
                    common one), and the alternative was closing the tab, going
                    back to Hosts and opening it again for something a second
                    attempt fixes. Same path as the disconnected banner's
                    Reconnect; it bumps the retry nonce and re-runs connect. */}
                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onReconnect(sessionId)}
                  >
                    Try again
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onClosed(sessionId)}
                  >
                    Close tab
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* An unsupported login shell (X4). Slim and dismissible: the shell still
          works, so this is a caveat, not a failure. Dismissing remembers the
          host, so a second tab on the same box doesn't say it again. Yields to
          the disconnected banner, which owns this slot when the shell is gone. */}
      {shellWarning && phase.kind === "open" && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-amber-500/30 bg-background/95 px-3 py-2">
          <span className="min-w-0 text-xs text-amber-700 dark:text-amber-300">
            {shellWarning.message}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              if (source.type === "ssh") {
                dismissShellWarning(source.hostId, shellWarning.key);
              }
              setShellWarning(null);
            }}
          >
            Got it
          </Button>
        </div>
      )}
      {/* Disconnected: keep scrollback readable, show a slim banner.

          The bar itself is mostly transparent, because the line it covers is
          the one that matters: the last thing the shell said before it went is
          usually why it went, and a solid bar put it out of reach at exactly
          the moment it was worth reading.

          The two things drawn on it do not follow it down, and for the same
          reason: what is behind them is arbitrary terminal output at arbitrary
          ANSI colours, and neither a control nor a sentence is readable
          floating over a wall of bright green. Legibility of what you have to
          read is not the part to trade away for a glimpse of what you don't.

          So each gets its own opaque plate and the gap between them stays
          clear, which is where the last line shows through. The message was
          dropped to a whisper instead, and against uncoloured output it came
          out very close to the text behind it, so the two read as one smear.
          Its plate is tinted by how the session ended, which is worth saying
          anyway: `exit 0` and a shell that died are the same slim bar
          otherwise.

          Both plates sit at the right, the message against the buttons, so the
          clear gap is one span at the left rather than a slot in the middle.
          A message pinned to the far corner had the whole bar's width between
          it and the button it is the reason for, and the eye had to cross the
          output to join them up. */}
      {phase.kind === "closed" && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-2 border-t border-border/40 bg-background/40 px-3 py-2">
          {/* Is the host back?

              Left of the closed message, on its own plate for the same reason
              everything else on this bar has one. It answers the question the
              operator is sitting here to have answered, which after a reboot is
              not "why did it go" but "can I go back yet".

              The colour follows the LAST probe and the figures follow the last
              two minutes, and the split is deliberate. The percentage is a
              reliability read: a host that finished rebooting fifteen seconds
              ago is five of forty probes, which is 12%, and painting that red
              would be telling the operator the machine is down at the exact
              moment it came back. So green means the port answered just now,
              which is the same as saying Reconnect will work; the ratio beside
              it says how solid that has been.

              Amber is the in-between the ratio is good for: the last probe
              missed, but the host has been answering within the window, which
              is a flap rather than an outage and reads differently from a
              machine that has been dark the whole time.

              Green has two readings, and saying which is which is the one thing
              this pill got wrong. Answering because the host never went down is
              not the same news as answering because it came back, and after a
              `reboot` the first is what you get: the shell is killed before
              sshd is, so the pane drops to this banner while the port is still
              open and the pill goes green on a machine that is about to
              disappear. An operator who knows the sequence reads it correctly
              and waits; everyone else reads "already back, that was fast" and
              is then annoyed when it turns amber ten seconds later.

              So the words differ even though the colour does not. Before
              anything has missed, the pill says the host is *still* answering,
              which is a report on a machine that has not gone yet. The ratio
              goes with it, because until something misses it is always n/n at
              100% and a figure that cannot say anything else is decoration.
              Once a probe has missed, the numbers mean something again and the
              pill switches to "back", which is the word that was wanted all
              along. */}
          {reachability !== null && (
            <span
              className={cn(
                "shrink-0 rounded-md border bg-background/90 px-2 py-0.5 font-mono text-xs tabular-nums",
                reachability.last
                  ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                  : reachability.percent >= 40
                    ? "border-amber-500/40 text-amber-700 dark:text-amber-300"
                    : "border-red-500/40 text-red-600 dark:text-red-400",
              )}
              {...hint(
                reachability.pending
                  ? "Checking whether this host's SSH port is accepting connections. It turns green when Reconnect will work."
                  : reachability.last && !reachability.everMissed
                    ? "This host's SSH port has answered every check since this terminal closed, so it has not gone down yet. After a reboot the port keeps answering for a few seconds before the machine actually goes; wait for this to drop before you expect it back."
                    : reachability.last
                      ? `This host went away and is answering again, so Reconnect should work. ${reachability.ok} of the last ${reachability.total} checks answered.`
                      : `This host is not answering on its SSH port. ${reachability.ok} of the last ${reachability.total} checks answered; the pill turns green the moment one does.`,
              )}
            >
              {reachability.pending
                ? "SSH ..."
                : reachability.last && !reachability.everMissed
                  ? "SSH still answering"
                  : `SSH ${reachability.last ? "back " : ""}${reachability.ok}/${reachability.total} ${reachability.percent}%`}
            </span>
          )}
          {/* The idle timeout closed this one, and it says so in full rather
              than in the slim message plate beside it.

              A session that ended while you were somewhere else is the one
              close where "why" is not obvious from anything on screen, and the
              honest answer is "a setting you chose did this", so the setting is
              a click away. Amber, not red: nothing went wrong. */}
          {phase.idle && (
            <span className="min-w-0 truncate rounded-md border border-amber-500/40 bg-background/90 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              Closed by the session timeout.{" "}
              {onOpenSessionSettings ? (
                <button
                  type="button"
                  onClick={onOpenSessionSettings}
                  className="underline underline-offset-2 hover:no-underline"
                >
                  Settings
                </button>
              ) : (
                "Settings"
              )}{" "}
              can change or switch it off.
            </span>
          )}
          <span
            className={cn(
              "min-w-0 truncate rounded-md border bg-background/90 px-2 py-0.5 text-xs",
              phase.clean
                ? "border-border/60 text-muted-foreground"
                : "border-amber-500/40 text-amber-700 dark:text-amber-300",
            )}
          >
            {phase.message}
          </span>
          <div className="flex shrink-0 items-center gap-2 rounded-md bg-background p-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReconnect(sessionId)}
            >
              Reconnect
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onClosed(sessionId)}
            >
              Close tab
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});
