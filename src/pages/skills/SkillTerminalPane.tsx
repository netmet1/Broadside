import { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "next-themes";

import { useTerminalFontZoom } from "@/lib/terminalZoom";
import { useUiPrefs } from "@/lib/uiPrefs";
import { onPtyData, ptyResize } from "@/lib/tauri/pty";
import {
  registerPaneSnapshot,
  unregisterPaneSnapshot,
} from "@/pages/skills/paneSnapshots";

/** xterm colours from the theme-aware CSS variables, so the pane matches the
 * app theme (same source as TerminalView). */
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

/**
 * One live xterm pane for a skill run's PTY.
 *
 * Deliberately *not* TerminalView: that component owns its session's whole
 * lifecycle (it calls `pty_open` on mount and `pty_close` on unmount), whereas
 * a skill run's PTY is opened and closed by the backend for the duration of the
 * run. This pane only binds to a session that already exists: watch it, and
 * type into it when the operator takes over.
 *
 * Keystrokes go through `onInput` (which routes to `skill_send_input`) and only
 * while `interactive`: the run's own controls decide when the operator has the
 * keyboard, so a stray click on a pane can't inject a keystroke into a shell
 * the engine is mid-step on.
 */
export function SkillTerminalPane({
  sessionId,
  interactive,
  resetNonce,
  onInput,
}: {
  sessionId: string;
  /** Whether the operator currently has the keyboard for this pane. */
  interactive: boolean;
  /** Bumped to re-initialize the xterm view, for recovering a display a
   * full-screen program left garbled (alternate screen, a stray scroll region).
   * Local only: it clears this pane's buffer, the remote keeps running. */
  resetNonce: number;
  onInput: (data: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Whether term.open() has run. It must not run until the container is
  // visible and sized (see the ResizeObserver below).
  const openedRef = useRef(false);
  // Whether this pane has pixels on screen, per the IntersectionObserver in
  // the setup effect. `fit()` must never run while this is false: xterm's
  // renderer is paused off screen and a fit lands against its stale
  // dimensions, which can drag the viewport to the top of its scrollback and
  // wedge the scrollbar (see TerminalView, where the grid made it reproducible).
  const intersectingRef = useRef(true);
  // Read from the data handler so it never re-subscribes (and so the pane never
  // misses bytes between renders). Copied in a layout effect, not during
  // render: a discarded render must not mutate anything outside itself, and a
  // layout effect still lands before the browser paints or delivers the next
  // event, so the handler cannot read a stale value.
  const interactiveRef = useRef(interactive);
  const onInputRef = useRef(onInput);
  const { prefs } = useUiPrefs();
  const prefsRef = useRef(prefs);
  useLayoutEffect(() => {
    interactiveRef.current = interactive;
    onInputRef.current = onInput;
    prefsRef.current = prefs;
  });
  // Same Ctrl + wheel zoom a Terminals pane has: this is a terminal too, and a
  // skill's output is exactly the kind of thing worth leaning in to read.
  useTerminalFontZoom(containerRef);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const term = new Terminal({
      fontFamily: prefsRef.current.terminalFontFamily,
      fontSize: prefsRef.current.terminalFontSize,
      cursorBlink: true,
      theme: readTerminalTheme(),
      scrollback: prefsRef.current.terminalScrollback,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Serialize the buffer on demand, so a handoff to a terminal tab can carry
    // this pane's scrollback across (see paneSnapshots). Registered by session
    // id and torn down on unmount below.
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    registerPaneSnapshot(sessionId, () => serialize.serialize());
    termRef.current = term;
    fitRef.current = fit;
    openedRef.current = false;

    const dataSub = term.onData((data) => {
      if (interactiveRef.current) onInputRef.current(data);
    });

    // Keep the remote PTY the same size as this xterm, so the shell doesn't
    // stay at the size the run opened it with while the pane fits a different
    // one. fit() below fires this with the real dimensions, but that first
    // fit races the SSH connect: the backend only registers the session once
    // the connection is up (seconds), so a resize sent before then is lost,
    // and with the pane's size never changing again it was never re-sent. The
    // remote then stays at the run's opening size while the pane shows more
    // rows, which is exactly the half-screen scroll region + bottom-line
    // overwrite mess apt/needrestart made. `sizeSynced` tracks whether a
    // resize has ever been delivered; the data handler below re-sends on the
    // first output, which cannot arrive before the session is registered.
    let sizeSynced = false;
    const syncSize = (cols: number, rows: number) => {
      ptyResize(sessionId, cols, rows).then(
        () => {
          sizeSynced = true;
        },
        () => {
          sizeSynced = false;
        },
      );
    };
    const resizeSub = term.onResize(({ cols, rows }) => {
      syncSize(cols, rows);
    });

    // Copy-on-select, matching the terminal tabs.
    const onMouseUp = () => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
    };
    const el = containerRef.current;
    el?.addEventListener("mouseup", onMouseUp);

    // Open the terminal only once its container actually has a size, and refit
    // on every later resize. Opening while the pane is hidden (display:none
    // during the params-to-run transition) makes xterm measure a zero-height
    // character cell, and every later fit then renders the pane at a fraction
    // of its true height (the reported half-viewport bug). The ResizeObserver
    // fires when the element gains a real size, which is exactly when it's safe
    // to open; writes made before open() are buffered and drawn on open.
    let io: IntersectionObserver | undefined;
    const observer = new ResizeObserver(() => {
      const node = containerRef.current;
      if (!node?.offsetParent) return;
      if (!openedRef.current) {
        term.open(node);
        openedRef.current = true;
        // Created here because it must be created after `term.open()`: xterm
        // registers its own IntersectionObserver inside open, observers fire
        // in creation order, so by the time this one reports the pane back on
        // screen xterm has already woken its renderer and re-measured the char
        // size. That makes this the one safe place to refit a returning pane;
        // a fit any earlier lands against the paused renderer's stale
        // dimensions (see TerminalView's matching observer for the full
        // pathology). It also covers a font change applied while hidden.
        io = new IntersectionObserver((entries) => {
          intersectingRef.current = entries[entries.length - 1].isIntersecting;
          if (intersectingRef.current) fit.fit();
        });
        io.observe(node);
      }
      if (!intersectingRef.current) return;
      fit.fit();
    });
    if (el) observer.observe(el);

    const unlistenData = onPtyData(sessionId, (bytes) => {
      term.write(bytes);
      // First proof the session is live on the backend: deliver the size the
      // pre-connect attempt lost. Marked synced up front so a burst of output
      // doesn't queue a resize per chunk; a failure unmarks it for the next.
      if (!sizeSynced && openedRef.current) {
        sizeSynced = true;
        syncSize(term.cols, term.rows);
      }
    });

    return () => {
      dataSub.dispose();
      resizeSub.dispose();
      observer.disconnect();
      io?.disconnect();
      el?.removeEventListener("mouseup", onMouseUp);
      void unlistenData.then((fn) => fn());
      unregisterPaneSnapshot(sessionId);
      term.dispose();
      openedRef.current = false;
      // No ptyClose here: the run owns this session and closes it when the host
      // finishes. Closing it on unmount would kill a live run.
    };
  }, [sessionId]);

  // Live appearance changes, without recreating the terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (
      term.options.fontFamily !== prefs.terminalFontFamily ||
      term.options.fontSize !== prefs.terminalFontSize
    ) {
      term.options.fontFamily = prefs.terminalFontFamily;
      term.options.fontSize = prefs.terminalFontSize;
      // Hidden (or not yet opened) panes are left alone: the
      // IntersectionObserver refits them on the way back, and an unopened
      // terminal measures the new font when it opens.
      if (
        openedRef.current &&
        intersectingRef.current &&
        containerRef.current?.offsetParent
      ) {
        fitRef.current?.fit();
      }
    }
  }, [prefs.terminalFontFamily, prefs.terminalFontSize]);

  // Scrollback. Separate from the fonts because no geometry changes, so there
  // is nothing to refit and a hidden pane can take it just as well as a visible
  // one. This pane holds a skill's output, which is the output most likely to
  // be long, so it gets the same allowance a terminal tab does.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.scrollback !== prefs.terminalScrollback) {
      term.options.scrollback = prefs.terminalScrollback;
    }
  }, [prefs.terminalScrollback]);

  // Re-theme on theme flip. Deferred a frame: next-themes flips the <html>
  // class in its own effect, which runs after this child's, so reading the
  // computed vars synchronously would lag one switch behind.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const term = termRef.current;
      if (term) term.options.theme = readTerminalTheme();
    });
    return () => cancelAnimationFrame(raf);
  }, [resolvedTheme]);

  // Focus the pane when the operator is handed the keyboard.
  useEffect(() => {
    if (interactive) termRef.current?.focus();
  }, [interactive]);

  // Re-initialize the view on demand. reset() clears xterm's buffer and any
  // alternate-screen / scroll-region state a rogue full-screen program left
  // behind, so the pane scrolls normally again. The remote is untouched; its
  // next output renders into the fresh view. Skips the first render (nonce 0).
  useEffect(() => {
    if (resetNonce === 0 || !openedRef.current) return;
    termRef.current?.reset();
    if (containerRef.current?.offsetParent) fitRef.current?.fit();
  }, [resetNonce]);

  // pl-[2px]: the same left gutter a Terminals pane has, for the same reason
  // and with the same reasoning behind putting it here rather than on `.xterm`.
  // See TerminalView's container.
  return <div ref={containerRef} className="h-full w-full pl-[2px]" />;
}
