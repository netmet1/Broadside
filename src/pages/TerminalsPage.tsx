import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";

import {
  TerminalView,
  type ConnectionGate,
  type TerminalSearchHandle,
} from "@/components/TerminalView";
import { TofuKeyDialog } from "@/components/TofuKeyDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import { SearchBar } from "@/components/SearchBar";
import { ptyClose } from "@/lib/tauri/pty";
import type { Host } from "@/lib/tauri/hosts";
import type { SearchOptions } from "@/lib/search";
import { usePageStatus } from "@/lib/status";
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
  usePageStatus(
    `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} open`,
    visible,
  );

  const [gates, setGates] = useState<Map<string, ConnectionGate>>(new Map());
  const [retryNonces, setRetryNonces] = useState<Map<string, number>>(
    new Map(),
  );

  // PTY Find (D-015 — Find only; filtering live interactive output is
  // incoherent).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState<{
    pattern: string;
    options: SearchOptions;
  } | null>(null);
  const [searchResults, setSearchResults] = useState<{
    index: number;
    count: number;
  } | null>(null);
  const searchHandles = useRef<Map<string, TerminalSearchHandle>>(new Map());

  const activeHandle = useCallback(
    () => (activeId !== null ? searchHandles.current.get(activeId) : undefined),
    [activeId],
  );

  // Ctrl+F while the Terminals page is visible. Presses with the terminal
  // focused arrive via onSearchRequest instead (xterm swallows them).
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "f" || e.key === "F") && !e.shiftKey) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery(null);
    setSearchResults(null);
    activeHandle()?.clearSearch();
    activeHandle()?.focusTerminal();
  }, [activeHandle]);

  // Switching tabs while searching: re-run the query against the new pane.
  useEffect(() => {
    if (!searchOpen || !searchQuery) return;
    setSearchResults(null);
    if (searchQuery.pattern) {
      activeHandle()?.findNext(searchQuery.pattern, searchQuery.options, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const handleQueryChange = (pattern: string, options: SearchOptions) => {
    setSearchQuery({ pattern, options });
    if (pattern) {
      activeHandle()?.findNext(pattern, options, true);
    } else {
      activeHandle()?.clearSearch();
      setSearchResults(null);
    }
  };

  const handleNavigate = (direction: 1 | -1) => {
    if (!searchQuery?.pattern) return;
    if (direction === 1) {
      activeHandle()?.findNext(searchQuery.pattern, searchQuery.options, false);
    } else {
      activeHandle()?.findPrevious(searchQuery.pattern, searchQuery.options);
    }
  };

  const searchStatus = (() => {
    if (!searchQuery?.pattern || !searchResults) return "";
    if (searchResults.count === 0) return "No matches";
    // resultIndex is -1 when the count exceeds the addon's highlight limit.
    return searchResults.index >= 0
      ? `${searchResults.index + 1}/${searchResults.count} matches`
      : `${searchResults.count} matches`;
  })();

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
    <div className="flex h-full flex-col">
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

      {searchOpen && (
        <SearchBar
          modes={["find"]}
          mode="find"
          onModeChange={() => {}}
          status={searchStatus}
          onQueryChange={handleQueryChange}
          onNavigate={handleNavigate}
          onClose={closeSearch}
        />
      )}

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
              ref={(handle) => {
                if (handle) {
                  searchHandles.current.set(s.id, handle);
                } else {
                  searchHandles.current.delete(s.id);
                }
              }}
              sessionId={s.id}
              hostId={s.host.id}
              visible={visible && s.id === activeId}
              retryNonce={retryNonces.get(s.id) ?? 0}
              onGate={handleGate}
              onClosed={closeSession}
              onSearchRequest={() => setSearchOpen(true)}
              onSearchResults={(index, count) =>
                setSearchResults({ index, count })
              }
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
