import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  Columns2Icon,
  EyeIcon,
  EyeOffIcon,
  Grid2x2Icon,
  Grid2x2XIcon,
  LayoutGridIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelTopIcon,
  PencilIcon,
  PlusIcon,
  Rows2Icon,
  SquareTerminalIcon,
  TerminalIcon,
  TextIcon,
  Trash2Icon,
  UndoIcon,
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
import { errorMessage } from "@/lib/tauri/hosts";
import { type LocalShell, listLocalShells } from "@/lib/tauri/local";
import {
  labelInitials,
  sessionLabel,
  sessionScope,
  type LocalShellOpenOpts,
  type TermSession,
} from "@/pages/terminals/session";
import { reconcileDisabledShells } from "@/lib/localShellPrefs";
import {
  loadProfiles,
  removeProfile,
  saveProfiles,
  upsertProfile,
  type ShellProfile,
} from "@/lib/localShellProfiles";
import { ShellProfileDialog } from "@/components/ShellProfileDialog";
import { useGridLayout } from "@/pages/terminals/useGridLayout";
import { useGridResize } from "@/pages/terminals/useGridResize";
import type { SearchOptions } from "@/lib/search";
import { getAppSettings } from "@/lib/tauri/settings";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import { cn } from "@/lib/utils";

const TABS_COMPACT_KEY = "terminal-tabs-compact";

/** Opening more than this many local shells at once first asks for confirmation
 * — a fat-fingered count shouldn't silently spawn a swarm of shells. Chosen so
 * the common "a handful at once" case (up to 7) stays friction-free. */
const BULK_SHELL_WARN = 7;

/** Fallback cap on the bulk-open count when the settings probe hasn't answered
 * yet (the real cap is the configured/suggested max concurrent sessions). */
const DEFAULT_MAX_SHELLS = 32;

/** Session shapes and naming live in ./terminals/session, so anything that only
 * needs "what is this tab called" can have it without importing this page.
 * Re-exported here because App and the broadcast pages already import the types
 * from this module. */
export type {
  SshTermSession,
  LocalTermSession,
  TermSession,
  LocalShellOpenOpts,
} from "@/pages/terminals/session";

/** Tab/menu icon for a local shell. WSL is grouped with SSH hosts under the
 * terminal icon; the Windows shells use the square-terminal icon. */
export function LocalShellIcon({
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
  /** Session ids with a live connection — a disconnected SSH tab shows a red label. */
  connectedSessions: Set<string>;
  onConnectionChange: (sessionId: string, connected: boolean) => void;
  onManageShortcuts: () => void;
  onActivate: (id: string) => void;
  onCloseSession: (id: string) => void;
  /** Reorder tabs: drop the dragged session in front of the target. */
  onReorder: (sourceId: string, targetId: string) => void;
  /** Rename a local shell tab for the rest of this session. An empty title
   * clears the override and falls back to the derived shell/profile label. */
  onRenameSession: (id: string, title: string) => void;
  /** Maximize the given terminal to fill the whole window. */
  onMaximize: (id: string) => void;
  /** Whether the terminal is currently maximized (hides the page chrome). */
  maximized: boolean;
  /** Whether the grid is filling the screen. Owned by App because it hides the
   * app chrome, driven from here because this is where the layout is known. */
  gridFullscreen: boolean;
  onGridFullscreen: (on: boolean) => void;
  /** Open a local shell (PowerShell / pwsh / Command Prompt / WSL) as a tab.
   * `opts` carries a saved profile's cwd / startup command / name when the open
   * came from a profile rather than a plain shell pick. */
  onOpenLocalShell: (shell: LocalShell, opts?: LocalShellOpenOpts) => void;
};

export function TerminalsPage({
  sessions,
  activeId,
  visible,
  connectedSessions,
  onConnectionChange,
  onManageShortcuts,
  onActivate,
  onCloseSession,
  onReorder,
  onRenameSession,
  onMaximize,
  maximized,
  gridFullscreen,
  onGridFullscreen,
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

  // Bulk-open: how many copies of a chosen shell the "+" launcher opens at once,
  // and the cap on that count (the configured max concurrent sessions, or the
  // machine's suggested max, whichever the settings expose). Kept as a string so
  // the input can be cleared while typing; parsed/clamped at open time.
  const [shellCount, setShellCount] = useState("1");
  const [maxShells, setMaxShells] = useState(DEFAULT_MAX_SHELLS);
  useEffect(() => {
    if (!visible) return;
    getAppSettings()
      .then((s) => {
        const cap =
          s.max_concurrent_sessions ??
          s.local_probe?.suggested_max_sessions ??
          DEFAULT_MAX_SHELLS;
        setMaxShells(Math.max(1, cap));
      })
      .catch(() => {});
  }, [visible]);
  // A pending bulk open awaiting the "that's a lot of shells" confirmation. Holds
  // the profile opts (cwd / startup / name) when the open came from a profile.
  const [bulkConfirm, setBulkConfirm] = useState<{
    shell: LocalShell;
    count: number;
    opts?: LocalShellOpenOpts;
  } | null>(null);

  // Open `count` copies of a shell (each append is a functional state update in
  // App, so N calls accumulate N distinct sessions). `opts` carries a profile's
  // cwd / startup command / name, applied identically to every copy.
  const openShells = useCallback(
    (shell: LocalShell, count: number, opts?: LocalShellOpenOpts) => {
      for (let i = 0; i < count; i++) onOpenLocalShell(shell, opts);
    },
    [onOpenLocalShell],
  );
  // Launcher pick: clamp the requested count to [1, maxShells]; if it's an
  // excessive batch, confirm first, otherwise open immediately. Shared by the
  // plain shell rows and the profile rows (the latter pass `opts`).
  const requestOpenShells = useCallback(
    (shell: LocalShell, opts?: LocalShellOpenOpts) => {
      setShellMenuOpen(false);
      const parsed = Number.parseInt(shellCount, 10);
      const n = Math.min(
        Math.max(Number.isFinite(parsed) ? parsed : 1, 1),
        maxShells,
      );
      if (n > BULK_SHELL_WARN) {
        setBulkConfirm({ shell, count: n, opts });
      } else {
        openShells(shell, n, opts);
      }
    },
    [shellCount, maxShells, openShells],
  );

  // Saved launch profiles (localStorage), re-read whenever the page is shown so
  // an edit made in the dialog on another visit reflects on return, like
  // disabledShells. Managed inline from the "+" launcher.
  const [profiles, setProfiles] = useState<ShellProfile[]>(loadProfiles);
  useEffect(() => {
    if (visible) setProfiles(loadProfiles());
  }, [visible]);
  // The profile editor: null = closed; { profile: null } = new; else edit.
  const [profileEdit, setProfileEdit] = useState<{
    profile: ShellProfile | null;
  } | null>(null);

  const persistProfiles = useCallback((next: ShellProfile[]) => {
    setProfiles(next);
    saveProfiles(next);
  }, []);
  const saveProfile = useCallback(
    (profile: ShellProfile) => {
      persistProfiles(upsertProfile(loadProfiles(), profile));
    },
    [persistProfiles],
  );
  const deleteProfile = useCallback(
    (id: string) => {
      persistProfiles(removeProfile(loadProfiles(), id));
    },
    [persistProfiles],
  );

  // Launch a saved profile: resolve its shell among the detected ones (a profile
  // can outlive a removed WSL distro), then open with its cwd / startup / name.
  const openProfile = useCallback(
    (profile: ShellProfile) => {
      const shell = localShells.find((s) => s.id === profile.shellId);
      if (!shell) {
        toast.error(
          `"${profile.label}" uses a shell that isn't available on this machine.`,
        );
        return;
      }
      requestOpenShells(shell, {
        cwd: profile.cwd || undefined,
        startupCommand: profile.startupCommand || undefined,
        profileLabel: profile.label,
      });
    },
    [localShells, requestOpenShells],
  );

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
  // A renamed tab still consumes its number so the tabs around it keep the
  // suffixes they already had, but shows none of its own: the operator gave it
  // an explicit name, and "Build box 02" would read as a duplicate of a tab
  // that doesn't exist.
  const tabSuffix = useMemo(() => {
    const counts = new Map<string, number>();
    const map = new Map<string, string>();
    for (const s of [...sessions].sort((a, b) => a.seq - b.seq)) {
      const key = s.type === "ssh" ? `ssh:${s.host.id}` : `local:${s.shell.id}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      const renamed = s.type === "local" && !!s.title;
      map.set(s.id, !renamed && n > 1 ? ` ${String(n).padStart(2, "0")}` : "");
    }
    return map;
  }, [sessions]);

  // Grid layout: which tiles, in what order, laid out how. See ./terminals/
  // useGridLayout — pure layout, nothing in it touches a PTY.
  const {
    layout,
    chooseLayout,
    gridMode,
    paneOrder,
    gridCount,
    displayIndex,
    excludedFromGrid,
    toggleGridExcluded,
    hideGridHeaders,
    toggleGridHeaders,
    twoUpSplit,
    toggleTwoUpSplit,
    gridPrefs,
    refreshGridPrefs,
    cell,
    customGrid,
    customColsAuto,
    gridStyle,
  } = useGridLayout({ sessions, visible, maximized });

  // Drag a tile's edge to set the tile size for the whole grid. Writes the same
  // Settings -> Grid prefs, so there is one source of truth and the Settings
  // numbers show what you dragged to.
  const { resizing, begin: beginResize, resetSize } = useGridResize({
    cell,
    onChange: refreshGridPrefs,
  });
  // Handles are pointless where a pinned tile size has no effect: in Tabs, and
  // at exactly two tiles (which always take the full window by design).
  const canResizeTiles = gridMode && gridCount !== 2;
  const sizeIsPinned =
    gridPrefs.itemCols !== null || gridPrefs.itemRows !== null;

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

  // Grid fullscreen: the tiles take the whole window and every bit of chrome
  // collapses to a hover strip at the top.
  //
  // F10 is registered here rather than in App (where F11 lives) so it can be
  // gated on this page being visible AND the grid being the active layout,
  // which is state App doesn't have. Capture phase, like F11, so xterm doesn't
  // swallow it first.
  //
  // Trade-off worth knowing: while the grid is showing, F10 no longer reaches a
  // terminal, and full-screen programs like mc and nano use it to quit. The
  // toolbar button is the primary affordance; the key is the accelerator.
  useEffect(() => {
    if (!visible || !gridMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F10") {
        e.preventDefault();
        e.stopPropagation();
        onGridFullscreen(!gridFullscreen);
      } else if (e.key === "Escape" && gridFullscreen) {
        // Esc only exits; it must stay available to the shell otherwise.
        e.preventDefault();
        e.stopPropagation();
        onGridFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, gridMode, gridFullscreen, onGridFullscreen]);

  // Leaving Grid (or maximizing a pane) has to give the chrome back, or it
  // would be missing with nothing on screen able to restore it.
  useEffect(() => {
    if (gridFullscreen && !gridMode) onGridFullscreen(false);
  }, [gridFullscreen, gridMode, onGridFullscreen]);

  // Drag-to-reorder tab state: the session being dragged and the tab it's
  // currently hovering over (drives the drop-indicator border).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Inline tab rename (local shells only): which tab is being edited and the
  // draft text. Committing calls onRenameSession; an empty draft clears the
  // override and the tab falls back to its shell name.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const startRename = useCallback((s: TermSession) => {
    setRenamingId(s.id);
    setRenameDraft(sessionLabel(s));
  }, []);
  const commitRename = useCallback(() => {
    setRenamingId((id) => {
      if (id !== null) onRenameSession(id, renameDraft);
      return null;
    });
  }, [onRenameSession, renameDraft]);

  // The horizontally-scrolling tab list + a live map of each tab's element, so
  // activating a session (e.g. via the "Go to session" picker) can scroll its
  // tab into view when it's off-screen.
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const tabElRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // When the active session changes, center its tab in the strip, but only if
  // it isn't already fully visible, so activating an on-screen tab never jumps.
  useEffect(() => {
    if (activeId === null) return;
    const container = tabScrollRef.current;
    const target = tabElRefs.current.get(activeId);
    if (!container || !target) return;
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (t.left >= c.left && t.right <= c.right) return; // already visible
    const delta = t.left + t.width / 2 - (c.left + c.width / 2);
    container.scrollTo({ left: container.scrollLeft + delta, behavior: "smooth" });
  }, [activeId, sessions]);

  // The scrolling grid container + a live map of each tile's element, so
  // selecting a tab/session while in Grid can bring its tile fully into view
  // when it's scrolled off (only >2 tiles ever scroll; otherwise this no-ops).
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const paneElRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // In Grid, when the active session changes, scroll its tile just enough to be
  // fully visible in the pane area, but leave it alone if it already is.
  useEffect(() => {
    if (!gridMode || activeId === null) return;
    const container = gridScrollRef.current;
    const target = paneElRefs.current.get(activeId);
    if (!container || !target) return;
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (t.top >= c.top && t.bottom <= c.bottom) return; // already fully visible
    // Scroll the minimum so the tile sits within the viewport (nearest edge).
    const delta =
      t.top < c.top ? t.top - c.top : t.bottom - c.bottom;
    container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
  }, [activeId, sessions, gridMode]);

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

  // Reconnect a closed/failed session: bump its retry nonce so TerminalView's
  // connect effect re-runs and re-opens the PTY on the same session id (the
  // backend id is free again once the old session ended).
  const reconnectSession = (id: string) => {
    setRetryNonces((prev) => new Map(prev).set(id, (prev.get(id) ?? 0) + 1));
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

  // Alt+Left/Right cycle through the open tabs (wrapping around the ends),
  // following the displayed tab order.
  const navTab = useCallback(
    (dir: "prev" | "next") => {
      if (sessions.length < 2 || activeId === null) return;
      const idx = sessions.findIndex((s) => s.id === activeId);
      if (idx < 0) return;
      const n = sessions.length;
      const nextIdx = dir === "next" ? (idx + 1) % n : (idx - 1 + n) % n;
      onActivate(sessions[nextIdx]!.id);
    },
    [sessions, activeId, onActivate],
  );

  // Alt+Left/Right while the Terminals page is visible but a terminal pane is
  // NOT focused (e.g. focus on the tab strip/chrome). Presses with a terminal
  // focused route through TerminalView's key handler (onTabNav) instead, since
  // xterm swallows window-level keydowns while it has focus.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.altKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        e.preventDefault();
        navTab(e.key === "ArrowRight" ? "next" : "prev");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, navTab]);

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
    <div className="relative flex h-full flex-col">
      {/* Chrome (controls + tab strip) is hidden while a terminal is maximized
          — only the terminal pane and the AppShell banner remain.

          In grid fullscreen the same chrome stays, but slides up out of the way
          so only a thin strip shows, and slides back down on hover or when
          anything inside it takes focus (so it is reachable from the keyboard
          too). It is positioned out of flow, so the tiles get the whole window.
          Deliberately a transform rather than a height animation with
          overflow-hidden: the "+" launcher's dropdown has to be able to escape
          the strip. */}
      {!maximized && (
        <div
          className={cn(
            gridFullscreen &&
              "absolute inset-x-0 top-0 z-40 -translate-y-[calc(100%-0.375rem)] border-b border-border bg-background shadow-lg transition-transform duration-150 focus-within:translate-y-0 hover:translate-y-0",
          )}
        >
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

        {/* Pane layout toggle: one tab at a time, or every open pane tiled at
            once like a skill run. A segmented switch rather than a single
            button so the current mode reads at a glance. */}
        <div
          role="group"
          aria-label="Terminal layout"
          className="flex items-center gap-0.5 rounded-md border border-input p-0.5"
        >
          <button
            type="button"
            onClick={() => chooseLayout("tabs")}
            aria-pressed={layout === "tabs"}
            className={cn(
              "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
              layout === "tabs"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            {...hint("One terminal at a time, picked with the tabs below.")}
          >
            <PanelTopIcon className="h-3.5 w-3.5" />
            Tabs
          </button>
          <button
            type="button"
            onClick={() => chooseLayout("grid")}
            aria-pressed={layout === "grid"}
            className={cn(
              "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
              layout === "grid"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            {...hint("Every open terminal tiled at once, like a skill run.")}
          >
            <LayoutGridIcon className="h-3.5 w-3.5" />
            Grid
          </button>
        </div>

        {/* Undo a drag-resize (or a pinned size set in Settings) and go back to
            fit-to-window. Only offered when a size is actually pinned, so it
            isn't a permanently dead button. */}
        {gridMode && sizeIsPinned && (
          <Button
            size="sm"
            variant="outline"
            onClick={resetSize}
            {...hint(
              "Clear the pinned tile size and go back to tiles that fit the window.",
            )}
          >
            <UndoIcon className="h-3.5 w-3.5" />
            Reset size
          </Button>
        )}

        {/* Take the grid fullscreen: every tile fills the screen and all the
            chrome (this bar, the tab strip, the sidebar and status bar)
            collapses to a hover strip at the top. Grid-only. */}
        {gridMode && (
          <Button
            size="sm"
            variant={gridFullscreen ? "secondary" : "outline"}
            onClick={() => onGridFullscreen(!gridFullscreen)}
            aria-pressed={gridFullscreen}
            {...hint(
              gridFullscreen
                ? "The grid fills the screen. Click (or press F10, or Esc) to come back."
                : "Fill the screen with the grid (F10). The controls collapse to a strip you hover to reveal.",
            )}
          >
            {gridFullscreen ? (
              <Minimize2Icon className="h-3.5 w-3.5" />
            ) : (
              <Maximize2Icon className="h-3.5 w-3.5" />
            )}
            Fullscreen
          </Button>
        )}

        {/* Hide/show every grid tile's title bar. Grid-only; the choice persists
            across restarts. Sits between the layout selector and the two-up flip. */}
        {gridMode && (
          <Button
            size="sm"
            variant="outline"
            onClick={toggleGridHeaders}
            {...hint(
              hideGridHeaders
                ? "Tile grid title bars are hidden. Click to show them."
                : "Tile grid title bars are shown. Click to hide them for a denser grid.",
            )}
          >
            {hideGridHeaders ? (
              <EyeOffIcon className="h-3.5 w-3.5" />
            ) : (
              <EyeIcon className="h-3.5 w-3.5" />
            )}
            Grid Titles
          </Button>
        )}

        {/* Flip the two-terminal grid between side-by-side and top/bottom.
            Only meaningful for exactly two tiles (one fills, three+ tile and
            scroll). Two tiles always take this layout, pinned Grid settings or
            not, so the flip is always offered here (customGrid is false at a
            count of two by construction). */}
        {gridMode && !customGrid && gridCount === 2 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              toggleTwoUpSplit()
            }
            {...hint(
              twoUpSplit === "cols"
                ? "Terminals are side by side. Click to stack them top and bottom."
                : "Terminals are stacked top and bottom. Click to place them side by side.",
            )}
          >
            {twoUpSplit === "cols" ? (
              <Columns2Icon className="h-3.5 w-3.5" />
            ) : (
              <Rows2Icon className="h-3.5 w-3.5" />
            )}
            {twoUpSplit === "cols" ? "Side by side" : "Top / bottom"}
          </Button>
        )}

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
        <div
          ref={tabScrollRef}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          // A remote tab that's open but not connected (connecting, dropped or
          // failed) reads as disconnected; local shells never are.
          const disconnected =
            s.type === "ssh" && !connectedSessions.has(s.id);
          const hostColor = s.type === "ssh" ? s.host.color : null;
          // The active tab tints with the host's own dot color when it's a
          // connected SSH tab with a valid hex color. Local shells and
          // disconnected tabs have no usable hue, so they fall back to a
          // theme-aware fill (bg-accent) with the foreground color as the bar.
          const hostTint =
            isActive &&
            !disconnected &&
            hostColor !== null &&
            /^#[0-9a-fA-F]{6}$/.test(hostColor);
          // ~20% alpha body fill + a full-strength top bar in the host color;
          // the theme-aware fallback just paints the 2px top bar. The top bar
          // rides the reserved transparent top border so nothing shifts. Set
          // inline (not via a border-t-* class) so it beats border-border/60.
          const activeStyle: React.CSSProperties | undefined = !isActive
            ? undefined
            : hostTint
              ? { backgroundColor: `${hostColor}33`, borderTopColor: hostColor! }
              : { borderTopColor: "var(--foreground)" };
          return (
          <div
            key={s.id}
            ref={(el) => {
              if (el) tabElRefs.current.set(s.id, el);
              else tabElRefs.current.delete(s.id);
            }}
            style={activeStyle}
            // A draggable ancestor swallows text selection inside the rename
            // input, so drag is switched off for the tab being renamed.
            draggable={renamingId !== s.id}
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
              // border-t-2/transparent is reserved on every tab so the active
              // top bar (painted via inline borderTopColor) never nudges layout.
              "group flex shrink-0 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 border-t-2 border-t-transparent px-3 py-1.5 text-sm",
              isActive
                ? cn(
                    "border-border/60 font-semibold text-foreground",
                    // Theme-aware fill for local/disconnected tabs; the host-
                    // tinted case paints its background via inline style.
                    !hostTint && "bg-accent",
                  )
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
            {(() => {
              if (renamingId === s.id) {
                return (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="w-32 rounded border border-input bg-background px-1 py-0 text-sm outline-none focus-visible:border-ring"
                    aria-label="Tab name"
                    spellCheck={false}
                    autoComplete="off"
                  />
                );
              }
              // Disconnected (connecting/dropped/failed) SSH tabs show their
              // label in red; when active it inherits the tab's bold weight, so
              // the active-disconnected tab reads as bold red on the theme tint.
              return tabsCompact ? (
                <span
                  className={cn("font-mono", disconnected && "text-red-500 dark:text-red-400")}
                >
                  {labelInitials(sessionLabel(s))}
                  {tabSuffix.get(s.id)}
                </span>
              ) : (
                <span
                  className={cn("max-w-40 truncate", disconnected && "text-red-500 dark:text-red-400")}
                >
                  {sessionLabel(s)}
                  {tabSuffix.get(s.id)}
                </span>
              );
            })()}
            {/* Rename a plain local shell tab for the rest of the session.
                Profile tabs already carry the profile's name, so they're left
                alone; SSH tabs are named by their host. */}
            {s.type === "local" && !s.profileLabel && renamingId !== s.id && (
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  startRename(s);
                }}
                aria-label={`Rename ${sessionLabel(s)}`}
                title="Rename this tab for this session"
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Take this terminal out of the grid, or put it back. Grid-only:
                in Tabs layout every tab shows its own pane anyway. The shell
                keeps running either way. */}
            {gridMode && (
              <button
                type="button"
                className={cn(
                  "rounded p-0.5 transition-opacity hover:bg-accent hover:text-foreground",
                  // An excluded tab keeps its icon visible without a hover, so
                  // you can find the hidden ones at a glance.
                  excludedFromGrid.has(s.id)
                    ? "text-amber-600 opacity-100 dark:text-amber-500"
                    : "text-muted-foreground opacity-0 group-hover:opacity-100",
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleGridExcluded(s.id);
                }}
                aria-pressed={excludedFromGrid.has(s.id)}
                aria-label={
                  excludedFromGrid.has(s.id)
                    ? `Show ${sessionLabel(s)} in the grid`
                    : `Hide ${sessionLabel(s)} from the grid`
                }
                title={
                  excludedFromGrid.has(s.id)
                    ? "Hidden from the grid. Click to put it back."
                    : "Hide this terminal from the grid (it keeps running)"
                }
              >
                {excludedFromGrid.has(s.id) ? (
                  <Grid2x2XIcon className="h-3.5 w-3.5" />
                ) : (
                  <Grid2x2Icon className="h-3.5 w-3.5" />
                )}
              </button>
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
          );
        })}
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
            <div className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
              {localShells.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {shellsError
                    ? "Couldn't list local shells. Rebuild the app and try again."
                    : "No local shells found."}
                </p>
              ) : (
                <>
                  {/* How many to open at once. Picking a shell or profile below
                      opens this many; a large batch confirms first. Capped at
                      the max concurrent sessions from Settings. */}
                  <div className="mb-1 flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
                    <label
                      htmlFor="shell-count"
                      className="text-xs text-muted-foreground"
                    >
                      How many
                    </label>
                    <input
                      id="shell-count"
                      type="number"
                      min={1}
                      max={maxShells}
                      value={shellCount}
                      onChange={(e) => setShellCount(e.target.value)}
                      className="w-16 rounded border border-input bg-background px-1.5 py-0.5 text-center font-mono text-xs"
                    />
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      max {maxShells}
                    </span>
                  </div>
                  {enabledShells.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      All local shells are hidden. Enable them in Settings,
                      Appearance.
                    </p>
                  ) : (
                    enabledShells.map((sh) => (
                      <button
                        key={sh.id}
                        type="button"
                        onClick={() => requestOpenShells(sh)}
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

                  {/* Saved launch profiles: a named shell + folder + optional
                      startup command. Shown regardless of the hide-list (a
                      profile may launch a shell hidden from the plain list) and
                      managed inline via the editor dialog. */}
                  <div className="mt-1 border-t border-border/60 pt-1">
                    <div className="flex items-center justify-between px-2 py-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Profiles
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setShellMenuOpen(false);
                          setProfileEdit({ profile: null });
                        }}
                        className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                        {...hint("Create a saved shell profile")}
                      >
                        <PlusIcon className="h-3.5 w-3.5" /> New
                      </button>
                    </div>
                    {profiles.length === 0 ? (
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        None yet. A profile opens a shell in a chosen folder and
                        can run a command on start.
                      </p>
                    ) : (
                      profiles.map((p) => {
                        // A profile can outlive a removed WSL distro; flag one
                        // whose shell isn't currently detected.
                        const shell = localShells.find(
                          (s) => s.id === p.shellId,
                        );
                        return (
                          <div
                            key={p.id}
                            className="group flex items-center gap-1 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                          >
                            <button
                              type="button"
                              onClick={() => openProfile(p)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                              title={
                                shell
                                  ? `${p.shellId}${p.cwd ? `: ${p.cwd}` : ""}`
                                  : "This profile's shell isn't available on this machine"
                              }
                            >
                              <LocalShellIcon
                                kind={shell?.kind ?? "cmd"}
                                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                              />
                              <span
                                className={cn(
                                  "truncate",
                                  !shell &&
                                    "text-muted-foreground line-through",
                                )}
                              >
                                {p.label}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setShellMenuOpen(false);
                                setProfileEdit({ profile: p });
                              }}
                              aria-label={`Edit ${p.label}`}
                              title="Edit profile"
                              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                            >
                              <PencilIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteProfile(p.id)}
                              aria-label={`Delete ${p.label}`}
                              title="Delete profile"
                              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-red-500 group-hover:opacity-100"
                            >
                              <Trash2Icon className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {/* The sliver left showing when the strip is slid up: a grab handle, so
          it reads as "there is something here" rather than a stray border. */}
      {gridFullscreen && (
        <div className="flex h-1.5 items-center justify-center bg-border/70">
          <div className="h-0.5 w-16 rounded-full bg-muted-foreground/70" />
        </div>
      )}
        </div>
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

      {/* In tabs mode one pane fills the area and the rest are display:none.
          In grid mode every pane tiles at once, mirroring the skill run panel.
          The pane wrappers keep the same key and structure in both modes (the
          header is present-but-hidden in tabs), so switching layout only
          restyles them — it never remounts a TerminalView, which would tear
          down its live PTY. */}
      <div
        ref={gridScrollRef}
        className={cn(
          "min-h-0 flex-1 bg-[var(--terminal-bg)] p-2",
          !gridMode && "relative",
          // Settings-driven grid (Settings -> Grid): a uniform layout with pinned
          // columns and/or character-based tile size. Overflow scrolls — the
          // fixed widths can exceed the viewport, and that scroll is intended.
          customGrid && "grid content-start gap-2 overflow-auto",
          customColsAuto && "grid-cols-1 lg:grid-cols-2",
          // Default fit-to-viewport grid, sized to the number of open terminals:
          //  1 tile  → fills the whole area,
          //  2 tiles → split full-height (two columns wide, stacked when narrow),
          //  3+ tiles → tile two-across and scroll, each a comfortable minimum.
          !customGrid &&
            gridMode &&
            gridCount === 1 &&
            "grid grid-cols-1 grid-rows-1 gap-2",
          // Two tiles: side-by-side full-height (stacking only when narrow), or
          // flipped to a fixed top/bottom split — the twoUpSplit toggle.
          !customGrid &&
            gridMode &&
            gridCount === 2 &&
            twoUpSplit === "cols" &&
            "grid grid-cols-1 grid-rows-2 gap-2 lg:grid-cols-2 lg:grid-rows-1",
          !customGrid &&
            gridMode &&
            gridCount === 2 &&
            twoUpSplit === "rows" &&
            "grid grid-cols-1 grid-rows-2 gap-2",
          !customGrid &&
            gridMode &&
            gridCount > 2 &&
            "grid grid-cols-1 content-start gap-2 overflow-auto lg:grid-cols-2",
        )}
        style={gridStyle}
      >
        {/* Every tile hidden but terminals still open: say so, or the grid
            reads as broken. */}
        {gridMode && gridCount === 0 && sessions.length > 0 && (
          <p className="col-span-full p-4 text-sm text-muted-foreground">
            Every terminal is hidden from the grid. Use the grid button on a tab
            to bring one back.
          </p>
        )}
        {paneOrder.map((s) => {
          const isActive = s.id === activeId;
          // Taken out of the grid from its tab. The pane stays mounted (and its
          // shell alive); it is simply not laid out.
          const excluded = gridMode && excludedFromGrid.has(s.id);
          const disconnected = s.type === "ssh" && !connectedSessions.has(s.id);
          // The active tile's header mirrors the tab tint: a ~20% host-colour
          // fill and a top bar in the host colour for a connected SSH tile,
          // falling back to the theme accent (with a foreground top bar) for
          // local or disconnected tiles that have no usable hue.
          const hostColor = s.type === "ssh" ? s.host.color : null;
          const hostTint =
            isActive &&
            !disconnected &&
            hostColor !== null &&
            /^#[0-9a-fA-F]{6}$/.test(hostColor);
          const headerStyle: React.CSSProperties | undefined = !isActive
            ? undefined
            : hostTint
              ? { backgroundColor: `${hostColor}33`, borderTopColor: hostColor! }
              : { borderTopColor: "var(--foreground)" };
          // Selected tile outlined in the host's own identifying colour (border +
          // a matching soft ring) instead of the theme primary. Only for a
          // connected SSH tile with a usable hue; local/disconnected fall back to
          // the primary classes below.
          const tileStyle: React.CSSProperties | undefined = !gridMode
            ? undefined
            : {
                // Visual position in the grid = position in the tab strip, so
                // dragging a tab rearranges the grid. See displayIndex.
                order: displayIndex.get(s.id) ?? 0,
                ...(hostTint
                  ? {
                      borderColor: hostColor!,
                      boxShadow: `0 0 0 1px ${hostColor}66`,
                    }
                  : {}),
              };
          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el) paneElRefs.current.set(s.id, el);
                else paneElRefs.current.delete(s.id);
              }}
              style={tileStyle}
              className={cn(
                gridMode
                  ? excluded
                    ? "hidden"
                    : cn(
                      // relative: anchors the resize handles below.
                      "relative flex min-w-0 flex-col overflow-hidden rounded-md border",
                      // Row height: a custom grid's row track sets the tile
                      // height (a pinned item-height, or minmax(floor,1fr) when
                      // auto), so the tile just fills it (min-h-0). The default
                      // grid keeps a legible floor for 3+ tiles and scrolls.
                      customGrid
                        ? "min-h-0"
                        : gridCount > 2
                          ? "min-h-[16rem]"
                          : "min-h-0",
                      isActive
                        ? // host-tinted tiles take their border+ring from tileStyle
                          hostTint
                          ? ""
                          : "border-primary/70 ring-1 ring-primary/40"
                        : "border-border/50",
                    )
                  : cn("h-full w-full", isActive ? "block" : "hidden"),
              )}
              onClick={gridMode ? () => onActivate(s.id) : undefined}
            >
              {/* Grid-only pane header: identifies the tile and carries the
                  same maximize/close affordances the tab has. Rendered (hidden)
                  in tabs mode so the TerminalView below never shifts position,
                  and hidden outright when the toolbar's 'Grid Titles' toggle is off.
                  border-t-2/transparent reserves the active top bar so tinting
                  never nudges the layout. */}
              <div
                style={headerStyle}
                className={cn(
                  "shrink-0 items-center gap-2 border-b border-t-2 border-border/40 border-t-transparent px-2 py-1",
                  gridMode && !hideGridHeaders ? "flex" : "hidden",
                  isActive
                    ? !hostTint && "bg-accent"
                    : "bg-muted/30",
                )}
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
                <span
                  className={cn(
                    "min-w-0 truncate text-sm font-medium",
                    disconnected
                      ? "text-red-500 dark:text-red-400"
                      : isActive
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
                  title={`${sessionLabel(s)}${tabSuffix.get(s.id) ?? ""}`}
                >
                  {sessionLabel(s)}
                  {tabSuffix.get(s.id)}
                </span>
                <button
                  type="button"
                  className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
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
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.id);
                  }}
                  aria-label={`Close ${sessionLabel(s)}`}
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>

              <div
                className={cn(
                  "min-w-0",
                  gridMode ? "min-h-0 flex-1" : "h-full w-full",
                  // While a tile edge is being dragged the pointer sweeps across
                  // other terminals; without this xterm would take those events
                  // and start selecting text (or feed them to a mouse-aware TUI).
                  resizing && "pointer-events-none",
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
                      : {
                          type: "local",
                          shellId: s.shell.id,
                          cwd: s.cwd,
                          startupCommand: s.startupCommand,
                        }
                  }
                  // A pane taken out of the grid is display:none, so it has no
                  // box to fit to — tell it so, exactly as a background tab in
                  // tabs mode is told, or it would fit against a zero size.
                  visible={visible && (gridMode ? !excluded : isActive)}
                  retryNonce={retryNonces.get(s.id) ?? 0}
                  onGate={handleGate}
                  onClosed={closeSession}
                  onReconnect={reconnectSession}
                  onSearchRequest={() => setSearchOpen(true)}
                  onTabNav={navTab}
                  onSearchResults={(index, count) =>
                    setSearchResults({ index, count })
                  }
                  onConnectionChange={onConnectionChange}
                  adoptExisting={s.type === "ssh" && s.adopted === true}
                  adoptSnapshot={s.type === "ssh" ? s.adoptSnapshot : undefined}
                />
              </div>

              {/* Resize handles. Dragging any tile's edge sets the tile size for
                  the WHOLE grid (it writes the Settings -> Grid character size),
                  so the tiles stay uniform and overflow scrolls, rather than one
                  tile growing out of step with the rest. Invisible until hovered
                  so they don't clutter a wall of terminals. */}
              {canResizeTiles && !excluded && (
                <>
                  <div
                    onMouseDown={(e) =>
                      beginResize(e, "x", paneElRefs.current.get(s.id) ?? null)
                    }
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Drag to set the width of every grid tile"
                    title="Drag to set the width of every tile"
                    className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-primary/40"
                  />
                  <div
                    onMouseDown={(e) =>
                      beginResize(e, "y", paneElRefs.current.get(s.id) ?? null)
                    }
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Drag to set the height of every grid tile"
                    title="Drag to set the height of every tile"
                    className="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize hover:bg-primary/40"
                  />
                  <div
                    onMouseDown={(e) =>
                      beginResize(e, "both", paneElRefs.current.get(s.id) ?? null)
                    }
                    role="separator"
                    aria-label="Drag to set the size of every grid tile"
                    title="Drag to set the size of every tile"
                    className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize hover:bg-primary/50"
                  />
                </>
              )}
            </div>
          );
        })}
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

      <AlertDialog
        open={bulkConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setBulkConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open that many shells?</AlertDialogTitle>
            <AlertDialogDescription>
              You're about to open{" "}
              <span className="font-semibold text-foreground">
                {bulkConfirm?.count} {bulkConfirm?.shell.label}
              </span>{" "}
              terminals at once. That's a lot of shells, and each one is a live
              process. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (bulkConfirm) openShells(bulkConfirm.shell, bulkConfirm.count);
                setBulkConfirm(null);
              }}
            >
              Open {bulkConfirm?.count}
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

      <ShellProfileDialog
        open={profileEdit !== null}
        onOpenChange={(open) => {
          if (!open) setProfileEdit(null);
        }}
        shells={enabledShells}
        initial={profileEdit?.profile ?? null}
        onSave={saveProfile}
      />
    </div>
  );
}
