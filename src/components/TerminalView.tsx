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
import { errorMessage } from "@/lib/tauri/hosts";
import {
  dismissShellWarning,
  shellNotice,
  shellWarningDismissed,
} from "@/lib/shells";
import type { SearchOptions } from "@/lib/search";
import { useTerminalFontZoom } from "@/lib/terminalZoom";
import { useUiPrefs } from "@/lib/uiPrefs";
import { cn } from "@/lib/utils";

/** Copy `sel` to the clipboard and flash a short confirmation toast. Nothing
 * on-screen otherwise signals that copy-on-select fired, so the toast is the
 * only feedback that the clipboard changed. A blank selection is a no-op. */
function copySelection(sel: string) {
  if (!sel) return;
  navigator.clipboard
    ?.writeText(sel)
    .then(() => toast.success("Copied to clipboard", { duration: 1200 }))
    .catch(() => {});
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

type Phase =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "gate"; gate: ConnectionGate }
  | { kind: "failed"; message: string }
  /** `clean` is how the session ended, not whether it ended: a shell that was
   * asked to go and went is clean, and a shell that died on its own or came
   * back non-zero is not. It only tints the message on the banner, so a wrong
   * guess costs a colour rather than a behaviour. */
  | { kind: "closed"; message: string; clean: boolean };

/** How far along a pane's connection is, without the message that goes with it.
 * Reported to the page (see `onPhaseChange`) because "not connected" is four
 * different situations and only two of them are worth retrying: a pane that is
 * still `connecting` has a connect in flight that a retry would tear down, and
 * one at a `gate` is waiting on a host-key dialog the operator has to answer
 * either way. `failed` and `closed` are the ones showing a Try again button. */
export type TerminalPhaseKind = Phase["kind"];

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
  /** Adopt a backend PTY that is already open (a skill run handed its shell
   * over) instead of opening a new one. Skips `pty_open` on the first mount and
   * binds to the existing session id; a later Reconnect opens for real. */
  adoptExisting?: boolean;
  /** The skill pane's scrollback as an ANSI string, written into this terminal
   * once on the adopting mount so the run's history is visible (adoption binds
   * to the live stream going forward; the backend does not replay the past). */
  adoptSnapshot?: string;
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
      onGate,
      onClosed,
      onReconnect,
      onSearchRequest,
      onTabNav,
      onSearchResults,
      onConnectionChange,
      onPhaseChange,
      adoptExisting,
      adoptSnapshot,
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
      phaseRef.current = p;
      setPhaseState(p);
      onConnectionChangeRef.current?.(sessionId, p.kind === "open");
      onPhaseChangeRef.current?.(sessionId, p.kind);
    },
    [sessionId],
  );

  // Create the terminal once.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: prefsRef.current.terminalFontFamily,
      fontSize: prefsRef.current.terminalFontSize,
      cursorBlink: true,
      theme: readTerminalTheme(),
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
      // are the explicit keyboard counterparts to copy-on-select (mouseup) and
      // right-click-paste, Ctrl+C/Ctrl+V alone stay reserved for the shell
      // (SIGINT / literal paste-through the shell may want).
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        e.preventDefault();
        copySelection(term.getSelection());
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
        e.preventDefault();
        navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) ptyWrite(sessionId, text).catch(() => {});
          })
          .catch(() => {});
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
      ptyWrite(sessionId, data).catch(() => {
        // Session already gone; the closed event handles UI state.
      });
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      ptyResize(sessionId, cols, rows).catch(() => {});
    });

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

    // Right-click to paste (Windows Terminal / PuTTY convention): read the
    // clipboard and send it to the shell as if typed. Suppresses the native
    // context menu. A no-op on a closed session (ptyWrite swallows the error).
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) ptyWrite(sessionId, text).catch(() => {});
        })
        .catch(() => {
          // Clipboard unreadable (empty or permission denied), ignore.
        });
    };
    const contextMenuEl = containerRef.current;
    contextMenuEl?.addEventListener("contextmenu", onContextMenu);

    // Copy-on-select (PuTTY / xterm convention): when a mouse selection ends,
    // copy it to the clipboard. Pairs with right-click-paste so the mouse alone
    // does both copy and paste. Fires once per drag (on mouseup) rather than on
    // every onSelectionChange tick, so we don't spam the clipboard mid-drag.
    const onMouseUp = () => {
      copySelection(term.getSelection());
    };
    contextMenuEl?.addEventListener("mouseup", onMouseUp);

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
          if (rest.length) term.write(rest);
          return;
        }
      }
      term.write(bytes);
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
      cancelAnimationFrame(refitRaf);
      observer.disconnect();
      io.disconnect();
      contextMenuEl?.removeEventListener("contextmenu", onContextMenu);
      contextMenuEl?.removeEventListener("mouseup", onMouseUp);
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
    // Pending profile startup-command injection (local shells), cleared if the
    // tab tears down or reconnects before it fires.
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
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
      {(phase.kind === "connecting" ||
        phase.kind === "gate" ||
        phase.kind === "failed") && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/85">
          <div className="max-w-md space-y-3 px-6 text-center">
            {phase.kind === "connecting" && (
              <p className="text-sm text-muted-foreground">Connecting…</p>
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
          otherwise. */}
      {phase.kind === "closed" && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-border/40 bg-background/40 px-3 py-2">
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
