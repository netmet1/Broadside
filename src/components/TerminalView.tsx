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
import { errorMessage } from "@/lib/tauri/hosts";
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

const SEARCH_DECORATIONS = {
  matchBackground: "#f59e0b4d",
  matchOverviewRuler: "#f59e0b4d",
  activeMatchBackground: "#f59e0b",
  activeMatchColorOverviewRuler: "#f59e0b",
};

type Phase =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "gate"; gate: ConnectionGate }
  | { kind: "failed"; message: string }
  | { kind: "closed"; message: string };

type Props = {
  sessionId: string;
  hostId: number;
  /** Whether this terminal's tab AND the Terminals page are visible. */
  visible: boolean;
  /** Bumps when the user resolves a TOFU gate — triggers a reconnect. */
  retryNonce: number;
  onGate: (sessionId: string, gate: ConnectionGate) => void;
  onClosed: (sessionId: string) => void;
  /** Ctrl+F pressed while the terminal has focus. */
  onSearchRequest: () => void;
  /** Live match feedback from the search addon. */
  onSearchResults: (resultIndex: number, resultCount: number) => void;
  /** Fires whenever this session's live-connection state flips (used for
   * the Hosts page connected indicators). */
  onConnectionChange?: (sessionId: string, connected: boolean) => void;
};

/** One xterm.js pane bound to one backend PTY session. Stays mounted (and
 * connected) while hidden so sessions survive page/tab switches. */
export const TerminalView = forwardRef<TerminalSearchHandle, Props>(
  function TerminalView(
    {
      sessionId,
      hostId,
      visible,
      retryNonce,
      onGate,
      onClosed,
      onSearchRequest,
      onSearchResults,
      onConnectionChange,
    }: Props,
    searchHandleRef,
  ) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const onSearchRequestRef = useRef(onSearchRequest);
  onSearchRequestRef.current = onSearchRequest;
  const onSearchResultsRef = useRef(onSearchResults);
  onSearchResultsRef.current = onSearchResults;
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;
  const { prefs } = useUiPrefs();
  // Read once at terminal creation; live changes are applied by the
  // prefs effect below without recreating the terminal.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const phaseRef = useRef<Phase>({ kind: "connecting" });
  const [phase, setPhaseState] = useState<Phase>({ kind: "connecting" });
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
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#3b82f680",
      },
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

    const unlistenData = onPtyData((id, bytes) => {
      if (id === sessionId) term.write(bytes);
    });
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
        searchRef.current?.findNext(pattern, {
          regex: options.regex,
          caseSensitive: options.caseSensitive,
          wholeWord: options.wholeWord,
          incremental,
          decorations: SEARCH_DECORATIONS,
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
          decorations: SEARCH_DECORATIONS,
        });
      } catch (err) {
        console.error("[TerminalView] search findPrevious failed", err);
        onSearchResultsRef.current(-1, 0);
      }
    },
    clearSearch: () => {
      try {
        searchRef.current?.clearDecorations();
      } catch (err) {
        console.error("[TerminalView] clearDecorations failed", err);
      }
    },
    focusTerminal: () => termRef.current?.focus(),
  }));

  // Connect (and reconnect after a TOFU gate is resolved).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      setPhase({ kind: "connecting" });
      if (containerRef.current?.offsetParent) fit.fit();
      try {
        const result = await ptyOpen({
          sessionId,
          hostId,
          cols: term.cols,
          rows: term.rows,
        });
        if (cancelled) return;
        switch (result.status) {
          case "opened":
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
            setPhase({ kind: "failed", message: `Authentication failed — ${result.message}` });
            break;
          case "unreachable":
            setPhase({ kind: "failed", message: `Unreachable — ${result.message}` });
            break;
          case "no_credentials":
            setPhase({
              kind: "failed",
              message: "No credentials stored — edit the host on the Hosts page.",
            });
            break;
        }
      } catch (e) {
        if (!cancelled) setPhase({ kind: "failed", message: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hostId, retryNonce]);

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
      {/* Disconnected: keep scrollback readable, show a slim banner. */}
      {phase.kind === "closed" && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 border-t border-border/50 bg-background/95 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {phase.message}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onClosed(sessionId)}
          >
            Close tab
          </Button>
        </div>
      )}
    </div>
  );
});
