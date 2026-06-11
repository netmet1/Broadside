import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

export type ConnectionGate = Extract<
  PtyOpenResult,
  { status: "unknown_key" } | { status: "key_mismatch" }
>;

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
};

/** One xterm.js pane bound to one backend PTY session. Stays mounted (and
 * connected) while hidden so sessions survive page/tab switches. */
export function TerminalView({
  sessionId,
  hostId,
  visible,
  retryNonce,
  onGate,
  onClosed,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const phaseRef = useRef<Phase>({ kind: "connecting" });
  const [phase, setPhaseState] = useState<Phase>({ kind: "connecting" });
  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  };

  // Create the terminal once.
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "Consolas, 'Cascadia Mono', monospace",
      fontSize: 13,
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
    if (containerRef.current) term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

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
      if (phaseRef.current.kind === "open") {
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
      resizeSub.dispose();
      observer.disconnect();
      unlistenData.then((fn) => fn());
      unlistenClosed.then((fn) => fn());
      term.dispose();
      ptyClose(sessionId).catch(() => {});
    };
     
  }, [sessionId]);

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
            setPhase({ kind: "open" });
            term.focus();
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
}
