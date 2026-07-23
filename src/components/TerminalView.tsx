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
  isShellSupported,
  loadDismissedShellWarnings,
  unsupportedShellMessage,
} from "@/lib/shells";
import type { SearchOptions } from "@/lib/search";
import { useUiPrefs } from "@/lib/uiPrefs";

export type ConnectionGate = Extract<
  PtyOpenResult,
  { status: "unknown_key" } | { status: "key_mismatch" }
>;

/** Imperative search surface for the Terminals page's Find bar (D-015 —
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

type Phase =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "gate"; gate: ConnectionGate }
  | { kind: "failed"; message: string }
  | { kind: "closed"; message: string };

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
  /** Bumps when the user resolves a TOFU gate — triggers a reconnect. */
  retryNonce: number;
  onGate: (sessionId: string, gate: ConnectionGate) => void;
  onClosed: (sessionId: string) => void;
  /** Re-open the PTY on this same session id (Reconnect button on the closed
   * banner). Bumps the parent's retry nonce, which re-runs the connect effect. */
  onReconnect: (sessionId: string) => void;
  /** Ctrl+F pressed while the terminal has focus. */
  onSearchRequest: () => void;
  /** Alt+Left/Right pressed while the terminal has focus — switch tabs. */
  onTabNav: (dir: "prev" | "next") => void;
  /** Live match feedback from the search addon. */
  onSearchResults: (resultIndex: number, resultCount: number) => void;
  /** Fires whenever this session's live-connection state flips (used for
   * the Hosts page connected indicators). */
  onConnectionChange?: (sessionId: string, connected: boolean) => void;
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
      onGate,
      onClosed,
      onReconnect,
      onSearchRequest,
      onTabNav,
      onSearchResults,
      onConnectionChange,
      adoptExisting,
      adoptSnapshot,
    }: Props,
    searchHandleRef,
  ) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // Resolves once the pty:data listener is actually registered. The connect
  // effect awaits this before opening so a shell that emits immediately (e.g.
  // PowerShell's startup cursor-position query, which it blocks on) isn't missed.
  const dataReadyRef = useRef<Promise<unknown> | null>(null);
  // Guards the one-time write of an adopted session's scrollback snapshot.
  const snapshotWrittenRef = useRef(false);
  const onSearchRequestRef = useRef(onSearchRequest);
  onSearchRequestRef.current = onSearchRequest;
  const onTabNavRef = useRef(onTabNav);
  onTabNavRef.current = onTabNav;
  const onSearchResultsRef = useRef(onSearchResults);
  onSearchResultsRef.current = onSearchResults;
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;
  const { prefs } = useUiPrefs();
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
  const [shellWarning, setShellWarning] = useState<string | null>(null);
  const setPhase = useCallback(
    (p: Phase) => {
      phaseRef.current = p;
      setPhaseState(p);
      onConnectionChangeRef.current?.(sessionId, p.kind === "open");
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
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.ctrlKey &&
        (e.key === "f" || e.key === "F")
      ) {
        onSearchRequestRef.current();
        return false;
      }
      // Ctrl+Shift+C copies the current selection; Ctrl+Shift+V pastes. These
      // are the explicit keyboard counterparts to copy-on-select (mouseup) and
      // right-click-paste — Ctrl+C/Ctrl+V alone stay reserved for the shell
      // (SIGINT / literal paste-through the shell may want).
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
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
        // TerminalsPage — otherwise both handlers fire for one keypress and the
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

    const observer = new ResizeObserver(() => {
      if (containerRef.current?.offsetParent) fit.fit();
    });
    if (containerRef.current) observer.observe(containerRef.current);

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
          // Clipboard unreadable (empty or permission denied) — ignore.
        });
    };
    const contextMenuEl = containerRef.current;
    contextMenuEl?.addEventListener("contextmenu", onContextMenu);

    // Copy-on-select (PuTTY / xterm convention): when a mouse selection ends,
    // copy it to the clipboard. Pairs with right-click-paste so the mouse alone
    // does both copy and paste. Fires once per drag (on mouseup) rather than on
    // every onSelectionChange tick, so we don't spam the clipboard mid-drag.
    const onMouseUp = () => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
    };
    contextMenuEl?.addEventListener("mouseup", onMouseUp);

    const unlistenData = onPtyData((id, bytes) => {
      if (id === sessionId) term.write(bytes);
    });
    dataReadyRef.current = unlistenData;
    const unlistenClosed = onPtyClosed((closed) => {
      if (closed.session_id !== sessionId) return;
      // Accept the close during "connecting" too — a shell can die in the
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
        setPhase({ kind: "closed", message: detail });
      }
    });

    return () => {
      dataSub.dispose();
      resultsSub.dispose();
      resizeSub.dispose();
      observer.disconnect();
      contextMenuEl?.removeEventListener("contextmenu", onContextMenu);
      contextMenuEl?.removeEventListener("mouseup", onMouseUp);
      unlistenData.then((fn) => fn());
      unlistenClosed.then((fn) => fn());
      term.dispose();
      ptyClose(sessionId).catch(() => {});
      onConnectionChangeRef.current?.(sessionId, false);
    };

  }, [sessionId, setPhase]);

  useImperativeHandle(searchHandleRef, () => ({
    findNext: (pattern, options, incremental) => {
      // The xterm search addon can throw on some inputs (smoke test 7.2:
      // the throw white-screened the app). Contain it here so a bad search
      // is a no-op, and log the stack for diagnosis rather than crashing.
      try {
        // No `decorations` here on purpose: passing them makes the addon
        // register overview-ruler match decorations, which throw unless the
        // terminal has a non-zero overview-ruler width — that throw (swallowed
        // by this catch since PR #20) is why every search said "No matches"
        // (T2). Without decorations, findNext still scrolls to + selects the
        // active match and reports the count via onDidChangeResults.
        searchRef.current?.findNext(pattern, {
          regex: options.regex,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          incremental,
        });
      } catch (err) {
        console.error("[TerminalView] search findNext failed", err);
        onSearchResultsRef.current(-1, 0);
      }
    },
    findPrevious: (pattern, options) => {
      try {
        searchRef.current?.findPrevious(pattern, {
          regex: options.regex,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
        });
      } catch (err) {
        console.error("[TerminalView] search findPrevious failed", err);
        onSearchResultsRef.current(-1, 0);
      }
    },
    clearSearch: () => {
      try {
        searchRef.current?.clearDecorations();
        // findNext highlights the active match via the terminal SELECTION (no
        // decorations — they threw), so clearing decorations alone leaves that
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
      // the id) and mark it open. Only on the first mount — a later Reconnect
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
        // Local shells have no host-key trust or auth gate — just spawn and open.
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
              }, 250);
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
          case "opened":
            // Flag a login shell we can't fully drive, unless this host's
            // warning was already dismissed (X4).
            if (
              result.login_shell &&
              !isShellSupported(result.login_shell) &&
              !loadDismissedShellWarnings().has(source.hostId)
            ) {
              setShellWarning(unsupportedShellMessage(result.login_shell));
            }
            // A pty:closed for this session may have raced ahead of the
            // open result — don't resurrect a dead session.
            if (phaseRef.current.kind !== "closed") {
              setPhase({ kind: "open" });
              term.focus();
            }
            break;
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
      if (containerRef.current?.offsetParent) fitRef.current?.fit();
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

  // Refit + focus when this pane becomes visible.
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (phaseRef.current.kind === "open") termRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onClosed(sessionId)}
                >
                  Close tab
                </Button>
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
            {shellWarning}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              if (source.type === "ssh") dismissShellWarning(source.hostId);
              setShellWarning(null);
            }}
          >
            Got it
          </Button>
        </div>
      )}
      {/* Disconnected: keep scrollback readable, show a slim banner. */}
      {phase.kind === "closed" && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-border/50 bg-background/95 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {phase.message}
          </span>
          <div className="flex items-center gap-2">
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
