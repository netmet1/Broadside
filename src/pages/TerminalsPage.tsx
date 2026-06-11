import { useState } from "react";
import { XIcon } from "lucide-react";

import {
  TerminalView,
  type ConnectionGate,
} from "@/components/TerminalView";
import { TofuKeyDialog } from "@/components/TofuKeyDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import { ptyClose } from "@/lib/tauri/pty";
import type { Host } from "@/lib/tauri/hosts";
import { cn } from "@/lib/utils";

export type TermSession = {
  id: string;
  /** Snapshot of the host at open time (rename/recolor mid-session is fine). */
  host: Host;
};

type Props = {
  sessions: TermSession[];
  activeId: string | null;
  visible: boolean;
  onActivate: (id: string) => void;
  onCloseSession: (id: string) => void;
};

export function TerminalsPage({
  sessions,
  activeId,
  visible,
  onActivate,
  onCloseSession,
}: Props) {
  const [gates, setGates] = useState<Map<string, ConnectionGate>>(new Map());
  const [retryNonces, setRetryNonces] = useState<Map<string, number>>(
    new Map(),
  );

  const handleGate = (sessionId: string, gate: ConnectionGate) => {
    setGates((prev) => new Map(prev).set(sessionId, gate));
  };

  const resolveGate = (sessionId: string) => {
    setGates((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    setRetryNonces((prev) =>
      new Map(prev).set(sessionId, (prev.get(sessionId) ?? 0) + 1),
    );
  };

  // Clearing the gate on dialog close (cancel OR accept — the dialogs close
  // themselves before onTrusted fires) leaves the session in its waiting
  // overlay; the overlay's own Close-tab button is the cancel path.
  const clearGate = (sessionId: string) => {
    setGates((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  };

  const closeSession = (id: string) => {
    ptyClose(id).catch(() => {});
    onCloseSession(id);
  };

  // Show the gate dialog for the active session only — switching tabs while
  // a gate is pending leaves that session in its waiting state.
  const activeGateSession =
    activeId !== null && gates.has(activeId)
      ? sessions.find((s) => s.id === activeId) ?? null
      : null;
  const activeGate = activeGateSession ? gates.get(activeGateSession.id)! : null;

  return (
    <div className="flex h-full min-h-screen flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 px-2 pt-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={cn(
              "group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-sm",
              s.id === activeId
                ? "border-border/60 bg-accent/40 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/20 hover:text-foreground",
            )}
            onClick={() => onActivate(s.id)}
            role="tab"
            aria-selected={s.id === activeId}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.host.color }}
            />
            <span className="max-w-40 truncate">{s.host.label}</span>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
              aria-label={`Close ${s.host.label}`}
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No open terminals. Open one from a host row on the Hosts page.
          </p>
        )}
      </div>

      <div className="relative min-h-0 flex-1 bg-[#0a0a0a] p-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={cn(
              "h-full w-full",
              s.id === activeId ? "block" : "hidden",
            )}
          >
            <TerminalView
              sessionId={s.id}
              hostId={s.host.id}
              visible={visible && s.id === activeId}
              retryNonce={retryNonces.get(s.id) ?? 0}
              onGate={handleGate}
              onClosed={closeSession}
            />
          </div>
        ))}
      </div>

      <TofuKeyDialog
        open={activeGate?.status === "unknown_key"}
        onOpenChange={(open) => {
          if (!open && activeGateSession) clearGate(activeGateSession.id);
        }}
        host={activeGateSession?.host ?? null}
        presentedKey={
          activeGate?.status === "unknown_key" ? activeGate.key : null
        }
        onTrusted={() => {
          if (activeGateSession) resolveGate(activeGateSession.id);
        }}
      />

      <KeyMismatchDialog
        open={activeGate?.status === "key_mismatch"}
        onOpenChange={(open) => {
          if (!open && activeGateSession) clearGate(activeGateSession.id);
        }}
        host={activeGateSession?.host ?? null}
        storedFingerprint={
          activeGate?.status === "key_mismatch"
            ? activeGate.stored_fingerprint
            : null
        }
        presented={
          activeGate?.status === "key_mismatch" ? activeGate.presented : null
        }
        onTrusted={() => {
          if (activeGateSession) resolveGate(activeGateSession.id);
        }}
      />
    </div>
  );
}
