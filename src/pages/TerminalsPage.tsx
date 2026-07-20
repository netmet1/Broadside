import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  LayoutGridIcon,
  Maximize2Icon,
  PanelTopIcon,
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
import { getAppSettings, type ShortcutScope } from "@/lib/tauri/settings";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import { cn } from "@/lib/utils";

const TABS_COMPACT_KEY = "terminal-tabs-compact";
const LAYOUT_KEY = "terminal-layout";

/** Opening more than this many local shells at once first asks for confirmation
 * — a fat-fingered count shouldn't silently spawn a swarm of shells. Chosen so
 * the common "a handful at once" case (up to 7) stays friction-free. */
const BULK_SHELL_WARN = 7;

/** Fallback cap on the bulk-open count when the settings probe hasn't answered
 * yet (the real cap is the configured/suggested max concurrent sessions). */
const DEFAULT_MAX_SHELLS = 32;

/** How the open terminals are laid out below the tab strip: one pane at a time
 * (the default) or every pane tiled at once, mirroring the skill run panel. */
type TermLayout = "tabs" | "grid";

/** Most initials we ever show. Camel/word splitting can produce a long run
 * (e.g. "aVeryLongCamelCaseName" → 6), which defeats the point of the compact
 * mode, so the result is trimmed to keep tabs tight. */
const MAX_INITIALS = 4;

/** Break a single word into its parts on camelCase / digit boundaries, keeping
 * runs of capitals together so acronyms stay one part:
 *   "webServer"      → ["web", "Server"]
 *   "XMLHttpRequest" → ["XML", "Http", "Request"]
 *   "SERVER"         → ["SERVER"]   (all-caps: one part → one initial)
 *   "server"         → ["server"]   (all-lowercase: one part → one initial)
 *   "box01"          → ["box", "01"] */
function splitWordParts(word: string): string[] {
  return word.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [];
}

/** Compact-tab initials. Words are separated by spaces, underscores and dashes,
 * and each word is further split on camelCase and letter/digit boundaries; the
 * first character of every part becomes an initial. All-caps, all-lowercase or
 * otherwise single-part words collapse to a single letter (so "PRODSERVER" and
 * "prodserver" both give "P"), and an over-eager camelCase run is trimmed to
 * MAX_INITIALS so a tab never sprouts a long acronym. Examples:
 *   "This is a test"  → "TIAT"      "web-server-01"        → "WS0"
 *   "prod_db_east"    → "PDE"       "myProdBox"            → "MPB"
 *   "aVeryLongName…"  → capped      "PRODSERVER"           → "P" */
function labelInitials(label: string): string {
  const parts = label
    .split(/[\s_-]+/)
    .filter(Boolean)
    .flatMap(splitWordParts);
  const initials = parts.map((p) => p[0]!.toUpperCase()).join("");
  const trimmed = initials.slice(0, MAX_INITIALS);
  return trimmed || label.slice(0, 2).toUpperCase();
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
  /** This tab adopted a PTY a skill run already had open (its `id` is that
   * backend session id). The first mount skips `pty_open`; a later Reconnect
   * opens a fresh shell to the host. */
  adopted?: boolean;
  /** The skill pane's scrollback as an ANSI string, seeded into the terminal on
   * its first (adopting) mount so the run's history carries over. */
  adoptSnapshot?: string;
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
  /** Session ids with a live connection — a disconnected SSH tab shows a red label. */
  connectedSessions: Set<string>;
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
  connectedSessions,
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
  // A pending bulk open awaiting the "that's a lot of shells" confirmation.
  const [bulkConfirm, setBulkConfirm] = useState<{
    shell: LocalShell;
    count: number;
  } | null>(null);

  // Open `count` copies of a shell (each append is a functional state update in
  // App, so N calls accumulate N distinct sessions).
  const openShells = useCallback(
    (shell: LocalShell, count: number) => {
      for (let i = 0; i < count; i++) onOpenLocalShell(shell);
    },
    [onOpenLocalShell],
  );
  // Launcher pick: clamp the requested count to [1, maxShells]; if it's an
  // excessive batch, confirm first, otherwise open immediately.
  const requestOpenShells = useCallback(
    (shell: LocalShell) => {
      setShellMenuOpen(false);
      const parsed = Number.parseInt(shellCount, 10);
      const n = Math.min(
        Math.max(Number.isFinite(parsed) ? parsed : 1, 1),
        maxShells,
      );
      if (n > BULK_SHELL_WARN) {
        setBulkConfirm({ shell, count: n });
      } else {
        openShells(shell, n);
      }
    },
    [shellCount, maxShells, openShells],
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
  // How many tiles the grid shows — drives the fill/split/scroll layout (B3).
  const gridCount = paneOrder.length;

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

  // Pane layout: one tab at a time (default) or every pane tiled like the skill
  // run panel. Persisted in localStorage so it survives tab switches (the page
  // stays mounted anyway) and program restarts. Maximizing always collapses to
  // the single fullscreen pane, so grid only applies when not maximized.
  const [layout, setLayout] = useState<TermLayout>(() =>
    localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "tabs",
  );
  const chooseLayout = useCallback((next: TermLayout) => {
    setLayout(next);
    localStorage.setItem(LAYOUT_KEY, next);
  }, []);
  const gridMode = layout === "grid" && !maximized;

  // Drag-to-reorder tab state: the session being dragged and the tab it's
  // currently hovering over (drives the drop-indicator border).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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
                <>
                  {/* How many to open at once. Picking a shell below opens this
                      many; a large batch confirms first. Capped at the max
                      concurrent sessions from Settings. */}
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
                      className="w-14 rounded border border-input bg-background px-1.5 py-0.5 text-right font-mono text-xs"
                    />
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      max {maxShells}
                    </span>
                  </div>
                  {enabledShells.map((sh) => (
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
                  ))}
                </>
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
          // Grid layout, sized to the number of open terminals (B3):
          //  1 tile  → fills the whole area,
          //  2 tiles → split full-height (two columns wide, stacked when narrow),
          //  3+ tiles → tile two-across and scroll, each a comfortable minimum.
          gridMode && gridCount === 1 && "grid grid-cols-1 grid-rows-1 gap-2",
          gridMode &&
            gridCount === 2 &&
            "grid grid-cols-1 grid-rows-2 gap-2 lg:grid-cols-2 lg:grid-rows-1",
          gridMode &&
            gridCount > 2 &&
            "grid grid-cols-1 content-start gap-2 overflow-auto lg:grid-cols-2",
        )}
      >
        {paneOrder.map((s) => {
          const isActive = s.id === activeId;
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
          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el) paneElRefs.current.set(s.id, el);
                else paneElRefs.current.delete(s.id);
              }}
              className={cn(
                gridMode
                  ? cn(
                      "flex min-w-0 flex-col overflow-hidden rounded-md border",
                      // 1-2 tiles stretch to fill their row; 3+ keep a floor so
                      // a tall stack stays legible and scrolls.
                      gridCount > 2 ? "min-h-[16rem]" : "min-h-0",
                      isActive
                        ? "border-primary/70 ring-1 ring-primary/40"
                        : "border-border/50",
                    )
                  : cn("h-full w-full", isActive ? "block" : "hidden"),
              )}
              onClick={gridMode ? () => onActivate(s.id) : undefined}
            >
              {/* Grid-only pane header: identifies the tile and carries the
                  same maximize/close affordances the tab has. Rendered (hidden)
                  in tabs mode so the TerminalView below never shifts position.
                  border-t-2/transparent reserves the active top bar so tinting
                  never nudges the layout. */}
              <div
                style={headerStyle}
                className={cn(
                  "shrink-0 items-center gap-2 border-b border-t-2 border-border/40 border-t-transparent px-2 py-1",
                  gridMode ? "flex" : "hidden",
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

              <div className={cn("min-w-0", gridMode ? "min-h-0 flex-1" : "h-full w-full")}>
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
                  visible={visible && (gridMode || isActive)}
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
              terminals at once. That's a lot of shells — each is a live process.
              Continue?
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
    </div>
  );
}
