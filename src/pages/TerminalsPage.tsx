import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  Maximize2Icon,
  PlusIcon,
  SquareTerminalIcon,
  TerminalIcon,
  TextIcon,
  XIcon,
} from "lucide-react";
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
import { type LocalShell, listLocalShells } from "@/lib/tauri/local";
import { reconcileDisabledShells } from "@/lib/localShellPrefs";
import type { SearchOptions } from "@/lib/search";
import type { ShortcutScope } from "@/lib/tauri/settings";
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

/** An SSH terminal (bound to a saved host) or a local shell (PowerShell / pwsh /
 * Command Prompt / WSL) hosted over ConPTY. Both share the same session id /
 * pty plumbing; only the source and tab affordances differ. */
/** Monotonic creation order, assigned when the tab opens. Drives the duplicate
 * " 02" suffix and the terminal-pane render order so neither depends on the
 * (drag-reorderable) display order. */
export type SshTermSession = {
  id: string;
  type: "ssh";
  seq: number;
  /** Snapshot of the host at open time (rename/recolor mid-session is fine). */
  host: Host;
};
export type LocalTermSession = {
  id: string;
  type: "local";
  seq: number;
  shell: LocalShell;
};
export type TermSession = SshTermSession | LocalTermSession;

/** Display label for a tab, regardless of session kind. */
function sessionLabel(s: TermSession): string {
  return s.type === "ssh" ? s.host.label : s.shell.label;
}

/** Which shortcut scope a tab belongs to. SSH hosts and local WSL tabs run
 * Linux (ssh); local Command Prompt / PowerShell run Windows commands (local). */
function sessionScope(s: TermSession): ShortcutScope {
  if (s.type === "ssh") return "ssh";
  return s.shell.kind === "wsl" ? "ssh" : "local";
}

/** Tab/menu icon for a local shell. WSL is grouped with SSH hosts under the
 * terminal icon; the Windows shells use the square-terminal icon. */
function LocalShellIcon({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  const Icon = kind === "wsl" ? TerminalIcon : SquareTerminalIcon;
  return <Icon className={className} />;
}

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
  /** Maximize the given terminal to fill the whole window. */
  onMaximize: (id: string) => void;
  /** Whether the terminal is currently maximized (hides the page chrome). */
  maximized: boolean;
  /** Open a local shell (PowerShell / pwsh / Command Prompt / WSL) as a tab. */
  onOpenLocalShell: (shell: LocalShell) => void;
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
  onMaximize,
  maximized,
  onOpenLocalShell,
}: Props) {
  const shortcuts = useShortcuts(visible);
  // Local shells available on this machine, for the "+" launcher menu.
  const [localShells, setLocalShells] = useState<LocalShell[]>([]);
  const [shellsError, setShellsError] = useState<string | null>(null);
  // Shells the user hid in Settings -> Appearance (stored by id).
  const [disabledShells, setDisabledShells] = useState<Set<string>>(new Set());
  useEffect(() => {
    listLocalShells()
      .then((s) => {
        setLocalShells(s);
        setShellsError(null);
      })
      .catch((e) => {
        // Surface the failure (e.g. a stale build missing the command) instead
        // of silently hiding the launcher.
        console.error("[TerminalsPage] listLocalShells failed", e);
        setShellsError(errorMessage(e));
      });
  }, []);
  // Re-read the hide list whenever the page is shown so changes made in Settings
  // (this page stays mounted) take effect on return. Reconcile drops ids no
  // longer detected so a shell that returns is enabled again.
  useEffect(() => {
    if (visible) {
      setDisabledShells(reconcileDisabledShells(localShells.map((s) => s.id)));
    }
  }, [visible, localShells]);
  const enabledShells = useMemo(
    () => localShells.filter((s) => !disabledShells.has(s.id)),
    [localShells, disabledShells],
  );
  // The local-shell launcher menu (a self-contained dropdown — robust in the
  // webview, unlike a Select used as an action menu).
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const launcherRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shellMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!launcherRef.current?.contains(e.target as Node)) {
        setShellMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShellMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [shellMenuOpen]);
  const hint = useHint();
  usePageStatus(
    `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} open`,
    visible,
  );

  // Suffix for duplicate terminals to the same target: the 2nd+ get " 02", " 03",
  // … so the tabs are distinguishable (T3). The first stays unsuffixed. Dedup key
  // is the host (SSH) or the shell id (local), so two PowerShell tabs also count.
  // Numbered by creation order (seq), NOT display order, so dragging a tab to a
  // new position never reshuffles the suffixes (the names stay put as the user
  // expects them to).
  const tabSuffix = useMemo(() => {
    const counts = new Map<string, number>();
    const map = new Map<string, string>();
    for (const s of [...sessions].sort((a, b) => a.seq - b.seq)) {
      const key = s.type === "ssh" ? `ssh:${s.host.id}` : `local:${s.shell.id}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      map.set(s.id, n > 1 ? ` ${String(n).padStart(2, "0")}` : "");
    }
    return map;
  }, [sessions]);

  // Terminal panes are rendered in stable creation order, decoupled from the
  // (drag-reorderable) tab order. The active pane is shown via CSS regardless of
  // its position, so pane order is invisible to the user -- and keeping it stable
  // means dragging a tab never moves a pane's DOM node, so the live xterm/PTY is
  // never torn down or remounted by a reorder.
  const paneOrder = useMemo(
    () => [...sessions].sort((a, b) => a.seq - b.seq),
    [sessions],
  );

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

  // Scope of the active tab, so the shortcut dropdown can enable only the
  // matching shortcuts (SSH/WSL run Linux; cmd/PowerShell run Windows commands).
  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeScope = activeSession ? sessionScope(activeSession) : null;

  /** Shortcut Go: type the command into the active terminal and press Enter.
   * PTY tabs bypass the guard by design (D-014) — the operator is
   * interactive here, same as if they typed it themselves. */
  const runShortcut = (cmd: string) => {
    if (activeId === null) return;
    // Submit with a carriage return (\r), the byte a real Enter keypress sends.
    // Windows ConPTY shells (PowerShell/cmd) need \r to execute; \n leaves the
    // line at a ">>" continuation prompt. \r is also correct for SSH/WSL.
    ptyWrite(activeId, cmd + "\r").catch((e) => {
      toast.error(errorMessage(e));
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Chrome (controls + tab strip) is hidden while a terminal is maximized
          — only the terminal pane and the AppShell banner remain. */}
      {!maximized && (
        <>
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
            activeScope={activeScope}
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
                      {s.type === "ssh" ? (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: s.host.color }}
                        />
                      ) : (
                        <LocalShellIcon
                          kind={s.shell.kind}
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="truncate">
                        {sessionLabel(s)}
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

      {/* Tab strip on its own line below the controls. The row itself does NOT
          scroll/clip — only the inner tab list does — so the "+" launcher's
          dropdown (which opens downward, below the strip) isn't clipped by an
          overflow container. (overflow-x:auto forces overflow-y to compute to
          auto too, which silently cropped the menu and made "+" look dead.) */}
      <div className="flex items-center gap-1 border-b border-border/50 px-2 pt-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {sessions.map((s) => (
          <div
            key={s.id}
            draggable
            onDragStart={(e) => {
              setDragId(s.id);
              e.dataTransfer.effectAllowed = "move";
              // Some webviews need drag data set or the drag is rejected.
              e.dataTransfer.setData("text/plain", s.id);
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
            title={tabsCompact ? `${sessionLabel(s)}${tabSuffix.get(s.id)}` : undefined}
          >
            {s.type === "ssh" ? (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: s.host.color }}
              />
            ) : (
              <LocalShellIcon
                kind={s.shell.kind}
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              />
            )}
            {tabsCompact ? (
              <span className="font-mono">
                {labelInitials(sessionLabel(s))}
                {tabSuffix.get(s.id)}
              </span>
            ) : (
              <span className="max-w-40 truncate">
                {sessionLabel(s)}
                {tabSuffix.get(s.id)}
              </span>
            )}
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onMaximize(s.id);
              }}
              aria-label={`Maximize ${sessionLabel(s)}`}
              title="Maximize this terminal to fill the window (F11)"
            >
              <Maximize2Icon className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
              aria-label={`Close ${sessionLabel(s)}`}
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        {sessions.length === 0 && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            No open terminals. Open an SSH host from the Hosts page, or a local
            shell with the + button.
          </p>
        )}
        </div>
        {/* "+" launcher for local shells (Windows Terminal style). A
            self-contained dropdown (not a Select) so it opens reliably. Kept
            OUTSIDE the scrolling tab list above so its downward menu isn't
            clipped by that container's overflow. */}
        <div ref={launcherRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setShellMenuOpen((v) => !v)}
            aria-label="New local shell"
            aria-expanded={shellMenuOpen}
            {...hint("Open a local shell (PowerShell, Command Prompt, WSL)")}
            className="flex h-7 items-center gap-0.5 rounded-md border border-input px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <PlusIcon className="h-4 w-4" />
            <ChevronDownIcon className="h-3 w-3" />
          </button>
          {shellMenuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
              {localShells.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {shellsError
                    ? "Couldn't list local shells. Rebuild the app and try again."
                    : "No local shells found."}
                </p>
              ) : enabledShells.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  All local shells are hidden. Enable them in Settings,
                  Appearance.
                </p>
              ) : (
                enabledShells.map((sh) => (
                  <button
                    key={sh.id}
                    type="button"
                    onClick={() => {
                      setShellMenuOpen(false);
                      onOpenLocalShell(sh);
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    <LocalShellIcon
                      kind={sh.kind}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    {sh.label}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
        </>
      )}

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
        {paneOrder.map((s) => (
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
              source={
                s.type === "ssh"
                  ? { type: "ssh", hostId: s.host.id }
                  : { type: "local", shellId: s.shell.id }
              }
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
        host={activeGateSession?.type === "ssh" ? activeGateSession.host : null}
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
        host={activeGateSession?.type === "ssh" ? activeGateSession.host : null}
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
