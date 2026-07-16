import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "next-themes";

import { useUiPrefs } from "@/lib/uiPrefs";
import { onPtyData, ptyResize } from "@/lib/tauri/pty";

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
  visible,
  onInput,
}: {
  sessionId: string;
  /** Whether the operator currently has the keyboard for this pane. */
  interactive: boolean;
  /** Whether the run panel is on screen. A pane mounts briefly hidden during
   * the params-to-run transition, and a terminal sized while hidden fits to a
   * zero-height box; this triggers a refit once it is shown. */
  visible: boolean;
  onInput: (data: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Read from the data handler so it never re-subscribes (and so the pane never
  // misses bytes between renders).
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  const { prefs } = useUiPrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const term = new Terminal({
      fontFamily: prefsRef.current.terminalFontFamily,
      fontSize: prefsRef.current.terminalFontSize,
      cursorBlink: true,
      theme: readTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (containerRef.current) term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data) => {
      if (interactiveRef.current) onInputRef.current(data);
    });

    // Keep the remote PTY the same size as this xterm. Without it the shell
    // stays at whatever size the run opened it with (a fixed 32 rows) while the
    // pane fits to a taller container, so the remote redraws inside its own
    // shorter screen and the output sticks near the bottom instead of scrolling
    // (the reported "stops scrolling, redraws at the bottom" bug). fit() below
    // fires this with the real dimensions.
    const resizeSub = term.onResize(({ cols, rows }) => {
      ptyResize(sessionId, cols, rows).catch(() => {});
    });

    // Copy-on-select, matching the terminal tabs.
    const onMouseUp = () => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
    };
    const el = containerRef.current;
    el?.addEventListener("mouseup", onMouseUp);

    const observer = new ResizeObserver(() => {
      if (containerRef.current?.offsetParent) fit.fit();
    });
    if (el) observer.observe(el);

    const unlistenData = onPtyData((id, bytes) => {
      if (id === sessionId) term.write(bytes);
    });

    // Fit once now the pane is in the DOM, so the remote is sized to match from
    // the first byte rather than waiting on the first ResizeObserver tick.
    const raf = requestAnimationFrame(() => {
      if (containerRef.current?.offsetParent) fit.fit();
    });

    return () => {
      cancelAnimationFrame(raf);
      dataSub.dispose();
      resizeSub.dispose();
      observer.disconnect();
      el?.removeEventListener("mouseup", onMouseUp);
      void unlistenData.then((fn) => fn());
      term.dispose();
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
      if (containerRef.current?.offsetParent) fitRef.current?.fit();
    }
  }, [prefs.terminalFontFamily, prefs.terminalFontSize]);

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

  // Refit when the run panel comes back on screen. A pane sized while its
  // container was display:none fitted to nothing; this corrects it (and resizes
  // the remote to match) the moment it is shown.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      if (containerRef.current?.offsetParent) fitRef.current?.fit();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return <div ref={containerRef} className="h-full w-full" />;
}
