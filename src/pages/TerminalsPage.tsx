import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import {
  TerminalView,
  type ConnectionGate,
  type TerminalSearchHandle,
} from "@/components/TerminalView";
import { TofuKeyDialog } from "@/components/TofuKeyDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import { SearchBar } from "@/components/SearchBar";
import { ShortcutBar } from "@/components/ShortcutBar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ptyClose, ptyWrite } from "@/lib/tauri/pty";
import { errorMessage, type Host } from "@/lib/tauri/hosts";
import type { SearchOptions } from "@/lib/search";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import { cn } from "@/lib/utils";

const TABS_COMPACT_KEY = "terminal-tabs-compact";

/** Initials of each whitespace-separated word, e.g. "This is a test" → "TIAT".
 * Used for the compact tab label mode. */
function labelInitials(label: string): string {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return initials || label.slice(0, 2).toUpperCase();
}

export type TermSession = {
  id: string;
  /** Snapshot of the host at open time (rename/recolor mid-session is fine). */
  host: Host;
};

type Props = {
  sessions: TermSession[];
  activeId: string | null;
  visible: boolean;
  onConnectionChange: (sessionId: string, connected: boolean) => void;
  onManageShortcuts: () => void;
  onActivate: (id: string) => void;
  onCloseSession: (id: string) => void;
  /** Reorder tabs: drop the dragged session in front of the target. */
  onReorder: (sourceId: string, targetId: string) => void;
};

export function TerminalsPage({
  sessions,
  activeId,
  visible,
  onConnectionChange,
  onManageShortcuts,
  onActivate,
  onCloseSession,
  onReorder,
}: Props) {
  const shortcuts = useShortcuts(visible);
  const hint = useHint();
  usePageStatus(
    `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} open`,
    visible,
  );

  // Suffix for duplicate terminals to the same host: the 2nd+ get " 02", " 03",
  // … so the tabs are distinguishable (T3). The first stays unsuffixed.
  const tabSuffix = useMemo(() => {
    const counts = new Map<number, number>();
    const map = new Map<string, string>();
    for (const s of sessions) {
      const n = (counts.get(s.host.id) ?? 0) + 1;
      counts.set(s.host.id, n);
      map.set(s.id, n > 1 ? ` ${String(n).padStart(2, "0")}` : "");
    }
    return map;
  }, [sessions]);

  // Tab label mode: full label (default) vs color-dot + initials. Persisted
  // like the sidebar-collapse pref (localStorage, UI-only).
  const [tabsCompact, setTabsCompact] = useState(
    () => localStorage.getItem(TABS_COMPACT_KEY) === "1",
  );
  const toggleTabsCompact = useCallback(() => {
    setTabsCompact((prev) => {
      const next = !prev;
      localStorage.setItem(TABS_COMPACT_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // Drag-to-reorder tab state: the session being dragged and the tab it's
  // currently hovering over (drives the drop-indicator border).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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

  // Close-all guard rail (T-…): confirm before tearing down every session.
  const [closeAllOpen, setCloseAllOpen] = useState(false);
  const closeAll = () => {
    for (const s of sessions) {
      ptyClose(s.id).catch(() => {});
      onCloseSession(s.id);
    }
    setCloseAllOpen(false);
  };

  // Show the gate dialog for the active session only — switching tabs while
  // a gate is pending leaves that session in its waiting state.
  const activeGateSession =
    activeId !== null && gates.has(activeId)
      ? sessions.find((s) => s.id === activeId) ?? null
      : null;
  const activeGate = activeGateSession ? gates.get(activeGateSession.id)! : null;

  /** Shortcut Go: type the command into the active terminal and press Enter.
   * PTY tabs bypass the guard by design (D-014) — the operator is
   * interactive here, same as if they typed it themselves. */
  const runShortcut = (cmd: string) => {
    if (activeId === null) return;
    ptyWrite(activeId, cmd + "\n").catch((e) => {
      toast.error(errorMessage(e));
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Controls line: tab-label toggle (left) + shortcut bar + a session
          picker for jumping between many open tabs (right). */}
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
        <Button
          size="sm"
          variant={tabsCompact ? "secondary" : "outline"}
          onClick={toggleTabsCompact}
          aria-pressed={tabsCompact}
          {...hint(
            tabsCompact
              ? "Tabs show the color dot + initials. Click for full labels."
              : "Tabs show the color dot + full label. Click for dot + initials.",
          )}
        >
          <TextIcon />
          {tabsCompact ? "Initials" : "Full labels"}
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <ShortcutBar
            shortcuts={shortcuts}
            disabled={activeId === null}
            onRun={runShortcut}
            onManage={onManageShortcuts}
          />
          {sessions.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCloseAllOpen(true)}
              {...hint(
                "Close every open terminal session at once (asks first)",
              )}
            >
              <XIcon />
              Close all
            </Button>
          )}
          {sessions.length > 0 && (
            <Select value={activeId ?? ""} onValueChange={(v) => onActivate(v)}>
              <SelectTrigger
                size="sm"
                className="w-48"
                aria-label="Jump to session"
                {...hint("Jump to an open terminal session")}
              >
                <SelectValue placeholder="Go to session…" />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: s.host.color }}
                      />
                      <span className="truncate">
                        {s.host.label}
                        {tabSuffix.get(s.id)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Tab strip on its own line below the controls. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 px-2 pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {sessions.map((s) => (
          <div
            key={s.id}
            draggable
            onDragStart={(e) => {
              setDragId(s.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!dragId || dragId === s.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (dragOverId !== s.id) setDragOverId(s.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dragId !== s.id) onReorder(dragId, s.id);
              setDragId(null);
              setDragOverId(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDragOverId(null);
            }}
            className={cn(
              "group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-sm",
              s.id === activeId
                ? "border-border/60 bg-accent/40 text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/20 hover:text-foreground",
              dragId === s.id && "opacity-40",
              dragOverId === s.id && "border-l-2 border-l-primary",
            )}
            onClick={() => onActivate(s.id)}
            role="tab"
            aria-selected={s.id === activeId}
            title={tabsCompact ? `${s.host.label}${tabSuffix.get(s.id)}` : undefined}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.host.color }}
            />
            {tabsCompact ? (
              <span className="font-mono">
                {labelInitials(s.host.label)}
                {tabSuffix.get(s.id)}
              </span>
            ) : (
              <span className="max-w-40 truncate">
                {s.host.label}
                {tabSuffix.get(s.id)}
              </span>
            )}
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

      <div className="relative min-h-0 flex-1 bg-[var(--terminal-bg)] p-2">
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
              onConnectionChange={onConnectionChange}
            />
          </div>
        ))}
      </div>

      <AlertDialog open={closeAllOpen} onOpenChange={setCloseAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close all terminals?</AlertDialogTitle>
            <AlertDialogDescription>
              This closes{" "}
              <span className="font-semibold text-foreground">
                all {sessions.length}
              </span>{" "}
              open terminal {sessions.length === 1 ? "session" : "sessions"} and
              disconnects them. Any unsaved work in those shells is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={closeAll}>
              Close all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
