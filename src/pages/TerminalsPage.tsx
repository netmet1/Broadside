import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  Grid2x2Icon,
  Grid2x2XIcon,
  Maximize2Icon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
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
import { Button } from "@/components/ui/button";
import {
  BAUD_RATES,
  DEFAULT_BAUD,
  listSerialPorts,
  loadBaud,
  saveBaud,
  serialAsShell,
  serialPortOf,
  type SerialPort,
} from "@/lib/tauri/serial";

import {
  TerminalView,
  type ConnectionGate,
  type TerminalPhaseKind,
  type TerminalSearchHandle,
} from "@/components/TerminalView";
import { TofuKeyDialog } from "@/components/TofuKeyDialog";
import { KeyMismatchDialog } from "@/components/KeyMismatchDialog";
import { SearchBar } from "@/components/SearchBar";
import { ptyClose, ptyWrite } from "@/lib/tauri/pty";
import { errorMessage } from "@/lib/tauri/hosts";
import { type LocalShell, listLocalShells } from "@/lib/tauri/local";
import {
  labelInitials,
  sessionColor,
  sessionLabel,
  sessionScope,
  type LocalShellOpenOpts,
  type TermSession,
} from "@/pages/terminals/session";
import {
  loadDisabledShells,
  reconcileDisabledShells,
} from "@/lib/localShellPrefs";
import { isTintable } from "@/lib/terminalColors";
import { useShellColors } from "@/lib/useShellColors";
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
import { BroadcastRail } from "@/pages/terminals/BroadcastRail";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";
import { TerminalRail } from "@/pages/terminals/TerminalRail";
import { useGridFocus } from "@/pages/terminals/useGridFocus";
import type { SearchOptions } from "@/lib/search";
import { getAppSettings } from "@/lib/tauri/settings";
import { useHint, usePageStatus } from "@/lib/status";
import { useShortcuts } from "@/lib/useShortcuts";
import { cn } from "@/lib/utils";

const TABS_COMPACT_KEY = "terminal-tabs-compact";
/** "1" shows the broadcast rail beside the panes. Persisted so the choice
 * survives a restart, like the layout and grid-title prefs. */
const BROADCAST_RAIL_KEY = "terminal-broadcast-rail";

/** Opening more than this many local shells at once first asks for confirmation:
 * a fat-fingered count shouldn't silently spawn a swarm of shells. Chosen so
 * the common "a handful at once" case (up to 7) stays friction-free. */
const BULK_SHELL_WARN = 7;
/** A profile with a startup command gets a far stricter threshold: every copy
 * runs that command again, and two accidental runs of a deploy script are a
 * different kind of accident than two idle prompts. Anything past one asks. */
const BULK_STARTUP_WARN = 1;

/** Fallback cap on the bulk-open count when the settings probe hasn't answered
 * yet (the real cap is the configured/suggested max concurrent sessions). */
const DEFAULT_MAX_SHELLS = 32;

/** Everything in the controls strip the keyboard can land on, in the order Tab
 * walks them. Ctrl+Shift+T focuses the first, and Tab wraps at the last: with
 * no wrap it walks off the end into the grid, where the next stops are per-tab
 * buttons that only appear on hover and then a terminal, and focusing a
 * terminal scrolls the grid under it. Hidden controls are skipped: the "+"
 * launcher's menu items are not in the DOM until it opens, but a disabled or
 * display:none control would otherwise be a stop with nothing to see. So is
 * anything holding tabindex="-1", which is how the tab strip keeps itself to a
 * single stop: a button is focusable by default, so asking for buttons and
 * leaving it there counted the per-tab controls of every session, including the
 * ones Tab itself walks straight past. */
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const found = root.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]",
  );
  return [...found].filter((el) => el.tabIndex >= 0 && el.offsetParent !== null);
}

/** Is a point inside an element's box? Measured, not hit-tested.
 *
 * getBoundingClientRect gives the rectangle the element is painted in, transform
 * and all, and it does not care what pointer-events has been set to: a box that
 * has been made inert is still exactly where it was. That is the whole reason
 * this exists rather than :hover or elementFromPoint. See the fullscreen strip's
 * pointer tracker for what makes the difference. */
function pointInBox(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Nothing hanging from the top of the window reaches this far down, so a
 * pointer below this line cannot be on the fullscreen strip and does not need
 * measuring. Only here to keep the tracker from reading layout on every mouse
 * move across a wall of terminals; the answer above the line is still measured.
 * A generous multiple of the tallest the strip gets at the largest app font. */
const STRIP_REACH_PX = 400;

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

/** Re-exported for the broadcast panels, which already import it from here. */
export { LocalShellIcon };

type Props = {
  sessions: TermSession[];
  activeId: string | null;
  visible: boolean;
  /** Session ids with a live connection, a disconnected SSH tab shows a red label. */
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

/** Whether this session's shell treats a form feed (Ctrl-L) as "redraw the
 * prompt", which is what Reset display leans on to bring the prompt back
 * without running anything.
 *
 * True for readline/zle shells (SSH hosts, WSL, Git Bash and friends) and for
 * PowerShell, where PSReadLine binds Ctrl-L to ClearScreen. False for Command
 * Prompt, whose console line editor has no binding for it and would leave the
 * character sitting on the command line. Unknown kinds are treated as Command
 * Prompt: a stray glyph on someone's prompt is a worse failure than a pane that
 * needs one press of Enter. */
function redrawsOnFormFeed(session: TermSession | undefined): boolean {
  if (!session) return false;
  if (session.type === "ssh") return true;
  return ["wsl", "posix", "powershell", "pwsh"].includes(session.shell.kind);
}

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
  // Re-read on every visit rather than once at mount, so a custom terminal
  // added in Settings shows up in the launcher straight away. The detected
  // shells behind this are cached in the backend, so the repeat calls only cost
  // a database read for the custom ones.
  // Re-read the hide list on every visit, so a change made in Settings takes
  // effect on return: this page stays mounted, so nothing else would notice.
  // Adjusted during render rather than inside the effect below, so the launcher
  // never paints the previous visit's list for a frame. It still lands before
  // the fetch's own prune, because render runs before the effect does.
  const [wasVisibleForShells, setWasVisibleForShells] = useState(visible);
  if (wasVisibleForShells !== visible) {
    setWasVisibleForShells(visible);
    if (visible) setDisabledShells(loadDisabledShells());
  }
  useEffect(() => {
    if (!visible) return;
    listLocalShells()
      .then((s) => {
        setLocalShells(s);
        setShellsError(null);
        // Pruning happens here, against the list that has just arrived, and not
        // in an effect of its own keyed on `localShells`. That is what this was,
        // and such an effect also runs the moment `visible` flips, when
        // `localShells` is still the empty array it starts as. Reconciling
        // against an empty list reads as "none of these shells exist any more",
        // so it deleted the whole hide list and saved the deletion, on the first
        // visit to this page in every run of the app. The setting looked like it
        // did not survive a restart because it did not.
        setDisabledShells(reconcileDisabledShells(s.map((x) => x.id)));
      })
      .catch((e) => {
        // Surface the failure (e.g. a stale build missing the command) instead
        // of silently hiding the launcher.
        console.error("[TerminalsPage] listLocalShells failed", e);
        setShellsError(errorMessage(e));
      });
  }, [visible]);
  const enabledShells = useMemo(
    () => localShells.filter((s) => !disabledShells.has(s.id)),
    [localShells, disabledShells],
  );
  // The local-shell launcher menu (a self-contained dropdown, robust in the
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

  // COM ports, for the launcher's serial section. Re-read every time the menu
  // opens rather than once at startup like the shell list: a USB serial adapter
  // is a thing you plug in, and a list fixed at launch would mean restarting the
  // app to see a dongle you have just connected. The enumeration is a registry
  // read, so asking again costs nothing.
  const [serialPorts, setSerialPorts] = useState<SerialPort[]>([]);
  // The line speed each port will open at. Seeded from what that port was last
  // opened at, so the second console session on the same cable is one click.
  const [serialBauds, setSerialBauds] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!shellMenuOpen) return;
    let cancelled = false;
    listSerialPorts()
      .then((ports) => {
        if (cancelled) return;
        setSerialPorts(ports);
        setSerialBauds((prev) => {
          const next = { ...prev };
          // Only fill gaps: a speed the operator has already changed in this
          // open menu must not be reset by the list refreshing under them.
          for (const p of ports) {
            if (next[p.name] === undefined) next[p.name] = loadBaud(p.name);
          }
          return next;
        });
      })
      .catch(() => {
        // No serial hardware, or an enumeration that failed: the section says
        // "no ports" either way, and nothing else in the menu is affected.
        if (!cancelled) setSerialPorts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [shellMenuOpen]);

  // Open one serial console. Deliberately not routed through requestOpenShells:
  // that exists to open N copies of a shell, and a COM port is exclusive, so the
  // second copy could only ever fail. One cable, one tab.
  const openSerial = useCallback(
    (port: SerialPort) => {
      const baud = serialBauds[port.name] ?? DEFAULT_BAUD;
      saveBaud(port.name, baud);
      setShellMenuOpen(false);
      onOpenLocalShell(serialAsShell(port, baud));
    },
    [serialBauds, onOpenLocalShell],
  );

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
  // plain shell rows and the profile rows (the latter pass `opts`). A profile
  // that types a startup command confirms past a single copy, not past 7.
  const requestOpenShells = useCallback(
    (shell: LocalShell, opts?: LocalShellOpenOpts) => {
      setShellMenuOpen(false);
      const parsed = Number.parseInt(shellCount, 10);
      const n = Math.min(
        Math.max(Number.isFinite(parsed) ? parsed : 1, 1),
        maxShells,
      );
      const warnAt = opts?.startupCommand ? BULK_STARTUP_WARN : BULK_SHELL_WARN;
      if (n > warnAt) {
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
  // Adjusted during render for the same reason as the hide list above: reading
  // localStorage is synchronous, so an effect only delays showing the truth.
  const [wasVisibleForProfiles, setWasVisibleForProfiles] = useState(visible);
  if (wasVisibleForProfiles !== visible) {
    setWasVisibleForProfiles(visible);
    if (visible) setProfiles(loadProfiles());
  }
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
        profileColor: profile.color || undefined,
      });
    },
    [localShells, requestOpenShells],
  );

  const hint = useHint();
  // Per-kind tab colours, live: Settings and this page are mounted at the same
  // time, so a colour changed there has to arrive here without a restart.
  const shellColors = useShellColors();
  // How many of the open tabs are actually up. Same rule the tab strip paints
  // red with: an SSH tab that is connecting, dropped or failed is not
  // connected, and a local shell never is anything else. Twenty tabs of which
  // four are red is not twenty sessions, and a count that says it is hides the
  // only number worth reading in a wall of terminals.
  const liveCount = useMemo(
    () =>
      sessions.filter((s) => s.type !== "ssh" || connectedSessions.has(s.id))
        .length,
    [sessions, connectedSessions],
  );
  usePageStatus(
    liveCount === sessions.length
      ? `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} open`
      : // Only when they differ, so the ordinary case still reads as a plain
        // count and the slash is a signal that something is down.
        `${liveCount}/${sessions.length} sessions connected`,
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

  // The scrolling grid container. Declared up here rather than beside the other
  // element refs below, because the layout hook measures it: how many columns
  // the grid can hold is a question about this pane's width, not the window's.
  const gridScrollRef = useRef<HTMLDivElement>(null);

  // Grid layout: which tiles, in what order, laid out how. See ./terminals/
  // useGridLayout, pure layout, nothing in it touches a PTY.
  const {
    layout,
    chooseLayout,
    gridMode,
    paneOrder,
    gridCount,
    displayIndex,
    excludedFromGrid,
    toggleGridExcluded,
    clearGridExcluded,
    hideGridHeaders,
    toggleGridHeaders,
    twoUpSplit,
    toggleTwoUpSplit,
    gridPrefs,
    setDragCols,
    setDragRows,
    resetTileSize,
    cell,
    headerH,
    tileMinH,
    gridSlot,
    tileSpan,
    customGrid,
    gridStyle,
  } = useGridLayout({ sessions, visible, maximized, paneRef: gridScrollRef });

  // Drag a tile's edge to set the tile size for the whole grid, for as long as
  // the program is running. Whether it also writes the Settings -> Grid numbers
  // is the strict setting's business, not this page's (see gridPrefs.ts).
  const { resizing, begin: beginResize } = useGridResize({
    cell,
    headerH,
    onCols: setDragCols,
    onRows: setDragRows,
  });
  // Handles are pointless where a pinned tile size has no effect: in Tabs, and
  // at one or two tiles (which always take the full window by design).
  const canResizeTiles = gridMode && gridCount > 2;
  const sizeIsPinned =
    gridPrefs.itemCols !== null || gridPrefs.itemRows !== null;

  // Broadcast rail: pick targets and type a command without leaving the page,
  // so the panes you are watching are the ones that answer. Off by default;
  // the choice persists across restarts.
  const [broadcastRail, setBroadcastRail] = useState(
    () => localStorage.getItem(BROADCAST_RAIL_KEY) === "1",
  );
  const toggleBroadcastRail = useCallback(() => {
    setBroadcastRail((on) => {
      localStorage.setItem(BROADCAST_RAIL_KEY, on ? "0" : "1");
      return !on;
    });
  }, []);

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

  // The controls + tab strip, and whether the keyboard is currently driving
  // them. See the Ctrl+Shift+T effect below for what the flag is for.
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const [chromeKeyboard, setChromeKeyboard] = useState(false);
  // Fullscreen only: a click in the strip has been acted on, so the strip is
  // done and should go even though the pointer is still sitting on it. This is
  // the one thing that can beat hover, and it is deliberately short-lived: the
  // pointer leaving clears it, so moving back to the strip always brings it
  // down again. See the click and mouse-leave handlers on the strip itself.
  const [stripDismissed, setStripDismissed] = useState(false);
  // Fullscreen only: is the pointer on the strip, or on the tab hanging off it?
  // Taken from the pointer's own coordinates rather than asked of :hover, and
  // that is the entire point of it.
  //
  // A Radix menu is modal, so opening one puts pointer-events:none on the body,
  // and nothing under an inert body can be hovered: while a menu from the strip
  // is up, the browser answers "no" to :hover wherever the pointer really is.
  // The menu's own data-state holds the strip down meanwhile, so that stayed
  // invisible, and the two do not end together. DismissableLayer puts the body
  // back in a *passive* effect cleanup, which React runs after the browser has
  // painted, so there is a painted frame with the hold gone and the body still
  // inert. Nothing held the strip for that frame. It set off up the screen and
  // came back when the style went: the bounce.
  //
  // A delay only hid that, and could never be better than a guess at how long
  // the frame is. This is not a guess. pointer-events decides what a mouse event
  // *hits*, not whether it is dispatched (Radix's own click-outside dismissal
  // rides on exactly that), so the moves still arrive while the body is inert,
  // and a point inside a rectangle is inside it whatever the hit-tester has been
  // told to ignore. The answer survives the frame because it was never the
  // hit-tester's to give.
  //
  // :hover stays on as a second holder, for the one thing coordinates cannot
  // see: a strip that arrives under a pointer which has not moved (Ctrl+Shift+T,
  // or a menu opening) is being hovered with no mouse move to notice it. Either
  // holder is enough on its own, and the same click drops both.
  const [stripHover, setStripHover] = useState(false);
  const stripHoverRef = useRef(false);
  const stripTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!gridFullscreen) return;
    const onMove = (e: MouseEvent) => {
      const inside =
        e.clientY <= STRIP_REACH_PX &&
        (pointInBox(chromeRef.current, e.clientX, e.clientY) ||
          pointInBox(stripTabRef.current, e.clientX, e.clientY));
      if (inside === stripHoverRef.current) return;
      stripHoverRef.current = inside;
      setStripHover(inside);
      // Arriving is a fresh visit, so it outranks a click that sent the strip
      // away. On the way in rather than on the way out, because the way in is
      // the edge that always comes: a pointer can be left sitting where the
      // strip never reaches, or on the tab it just clicked, and from either
      // place the next thing it does is arrive.
      if (inside) setStripDismissed(false);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      stripHoverRef.current = false;
      setStripHover(false);
    };
  }, [gridFullscreen]);
  const chromeHasFocus = useCallback(
    () =>
      document.activeElement !== null &&
      chromeRef.current !== null &&
      chromeRef.current.contains(document.activeElement),
    [],
  );

  // Grid fullscreen: the tiles take the whole window and every bit of chrome
  // collapses to a hover strip at the top.
  //
  // Ctrl+Shift+G rather than a function key. Anything a terminal program might
  // use is a key we would be taking away from it: F10 quits mc and opens nano's
  // menu, and those are exactly the programs you run in a wall of terminals.
  // Ctrl+Shift+<letter> is safe because a terminal cannot see the Shift at all
  // (Ctrl+Shift+G and Ctrl+G arrive at the shell as the same byte), so taking
  // it costs a program nothing it could have told apart from plain Ctrl+G.
  //
  // Ctrl+Shift+G is the whole of it, in and out. Esc used to come back out too
  // and no longer does, on purpose: a fullscreen grid is a wall of terminals,
  // the program most likely to be running in one of them is vi, and Esc is the
  // key vi is built around. Claiming it meant the first Esc of every editing
  // session left fullscreen instead of leaving insert mode, in the layout where
  // the most terminals are on screen to be caught by it. The ways out that cost
  // a program nothing are Ctrl+Shift+G and the strip's own button.
  //
  // Esc does still do one thing on this page, further down: with the keyboard
  // in the controls strip it hands focus back to the terminal. That case is
  // safe by construction, because the keyboard is not in a terminal at all.
  //
  // Registered here rather than in App (where F11 lives) so it can be gated on
  // this page being visible AND the grid being the active layout, which is
  // state App doesn't have. Capture phase, like F11, so xterm doesn't swallow
  // it first.
  useEffect(() => {
    if (!visible || !gridMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === "G" || e.key === "g")) {
        e.preventDefault();
        e.stopPropagation();
        onGridFullscreen(!gridFullscreen);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, gridMode, gridFullscreen, onGridFullscreen]);

  // Ctrl+Shift+T puts keyboard focus into the controls. In grid fullscreen they
  // are slid up out of the way and the mouse was the only way back to them:
  // pressing Tab cannot do it, because Tab belongs to whatever has focus, and
  // in a grid that is a terminal, where Tab is the shell's own completion key.
  // Setting chromeKeyboard is what slides the strip down, so this is the whole
  // of the way in; Tab and Shift+Tab then walk it, and Esc hands the
  // keyboard back to the terminal. Same reasoning as Ctrl+Shift+G for the
  // letter: a terminal cannot see the Shift, so nothing is taken from the
  // program.
  //
  // `chromeKeyboard` says the keyboard got here by this shortcut, and it does
  // two things nothing else can:
  //
  //  - It paints the ring, and in grid fullscreen it is also what holds the
  //    strip on screen. Programmatic focus does not reliably satisfy
  //    :focus-visible, so the first press moved focus with nothing on screen to
  //    show for it and the ring only appeared after a Tab. A flag we set
  //    ourselves does not guess, which matters twice as much now that the strip
  //    no longer comes down for focus alone.
  //  - It keeps Tab in the strip. Walking off the end used to fall into the
  //    grid, first through per-tab buttons that are invisible until hovered and
  //    then into a tile, where focusing a terminal scrolls the grid and leaves
  //    the tile looking broken. Tab wraps within the strip instead; Esc is the
  //    way out, and ordinary Tab from elsewhere in the app is untouched.
  useEffect(() => {
    if (!visible || maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && chromeHasFocus()) {
        // Not from a text field in the strip: Esc in the tab-rename box means
        // "abandon the rename", and this listener is on the capture phase, so
        // without this it would take that key before the box ever saw it.
        const el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setChromeKeyboard(false);
        searchHandles.current.get(activeId ?? "")?.focusTerminal();
        return;
      }
      if (!e.ctrlKey || !e.shiftKey || e.altKey) return;
      if (e.key !== "T" && e.key !== "t") return;
      const first = focusablesIn(chromeRef.current)[0];
      if (!first) return;
      e.preventDefault();
      e.stopPropagation();
      setChromeKeyboard(true);
      // Asking for the strip out loud outranks a click that dismissed it.
      setStripDismissed(false);
      first.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, maximized, activeId, chromeHasFocus]);

  // Tab and Shift+Tab while the strip has the keyboard: wrap at both ends
  // rather than let focus escape into the grid.
  const onChromeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Tab") return;
      if (!chromeKeyboard) {
        // Reaching for Tab in here is the keyboard taking over, whether or not
        // Ctrl+Shift+T was what got focus in. Worth saying so only in
        // fullscreen, where the strip stays on screen for exactly as long as
        // this flag is set: click a control with the mouse, move the pointer
        // off, then press Tab, and without this focus would walk along a strip
        // that had already slid away. Outside fullscreen the chrome is always
        // visible and ordinary Tab should stay ordinary, so nothing changes.
        if (!gridFullscreen) return;
        setChromeKeyboard(true);
        setStripDismissed(false);
      }
      const items = focusablesIn(chromeRef.current);
      if (items.length === 0) return;
      const here = items.indexOf(document.activeElement as HTMLElement);
      if (here === -1) return;
      const next = e.shiftKey ? here - 1 : here + 1;
      // Anywhere in the middle is the browser's job; only the two ends are ours.
      if (next >= 0 && next < items.length) return;
      e.preventDefault();
      items[e.shiftKey ? items.length - 1 : 0]?.focus();
    },
    [chromeKeyboard, gridFullscreen],
  );

  // Leaving Grid (or maximizing a pane) has to give the chrome back, or it
  // would be missing with nothing on screen able to restore it. So does closing
  // the last terminal, whether one tab at a time or with Close all: fullscreen
  // is for filling the screen with something, and an empty black screen with
  // the chrome hidden gives no sign that the app is still there.
  //
  // Deliberately "no sessions" rather than "nothing in the grid". Every tile
  // hidden while tabs are still open is a state the grid supports and explains
  // in words, and the tabs to undo it with are in the strip a hover away.
  useEffect(() => {
    if (!gridFullscreen) return;
    if (!gridMode || sessions.length === 0) onGridFullscreen(false);
  }, [gridFullscreen, gridMode, sessions.length, onGridFullscreen]);

  // Entering fullscreen starts with the strip in play, whatever the last thing
  // clicked before it was. Outside fullscreen the flag does nothing, so it can
  // sit set for as long as it likes; this is only so it cannot be found still
  // set on the way back in.
  if (!gridFullscreen && stripDismissed) setStripDismissed(false);

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

  // Which tab the strip's single Tab stop is currently sitting on. Null means
  // the active one, which is where the strip always starts and where it goes
  // back to when the keyboard leaves it.
  //
  // The strip being *one* stop is the whole point, and the tabindex on the tabs
  // was only half of it. A button is focusable whether or not anyone says so,
  // so the rename, hide, maximize and close buttons inside every tab were four
  // more stops each: Tab walked past the tabs themselves (they are divs, and
  // only the active one carried a tabindex) straight into the next session's
  // little buttons, which is four presses per session to get anywhere and no
  // way to see which tab you were on. Now the tab that holds the stop is the
  // only one whose buttons are in the tab order, so Tab lands on a tab, the
  // arrows walk between them, and Tab again reaches that tab's own controls.
  const [tabStopId, setTabStopId] = useState<string | null>(null);
  const rovingTabId =
    tabStopId !== null && sessions.some((s) => s.id === tabStopId)
      ? tabStopId
      : (activeId ?? sessions[0]?.id ?? null);

  // Arrow keys walk the tab strip, Enter or Space picks one (see the tab's own
  // key handler). Deliberately not the other pattern, where arrowing switches
  // session as it goes: activating a session re-points the shortcut bar, Find
  // and every keystroke at another host, and walking past four of them on the
  // way to the fifth is not four decisions.
  const onTabStripKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        e.key !== "ArrowLeft" &&
        e.key !== "ArrowRight" &&
        e.key !== "Home" &&
        e.key !== "End"
      ) {
        return;
      }
      // Only while the keyboard is on a tab. A rename box in one of them wants
      // Home and the arrows for editing text.
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el.getAttribute("role") !== "tab") {
        return;
      }
      const tabs = sessions
        .map((s) => ({ id: s.id, el: tabElRefs.current.get(s.id) }))
        .filter((t): t is { id: string; el: HTMLDivElement } => t.el !== undefined);
      const here = tabs.findIndex((t) => t.el === el);
      if (here === -1) return;
      e.preventDefault();
      const last = tabs.length - 1;
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? last
            : e.key === "ArrowLeft"
              ? (here - 1 + tabs.length) % tabs.length
              : (here + 1) % tabs.length;
      const target = tabs[next];
      if (!target) return;
      // The stop moves with the keyboard, so Tab from here reaches this tab's
      // own buttons rather than the active tab's.
      setTabStopId(target.id);
      target.el.focus();
    },
    [sessions],
  );

  // A live map of each tile's element, so selecting a tab/session while in Grid
  // can bring its tile fully into view when it's scrolled off (only >2 tiles
  // ever scroll; otherwise this no-ops). The container itself is gridScrollRef,
  // declared above the layout hook because that hook measures it.
  const paneElRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Per-pane imperative handles (find, and focusing the terminal itself).
  // Declared up here with the refs it sits beside, because the scroll effects
  // below read `gridFocus` in their dependency arrays, which is evaluated
  // during render rather than inside the closure.
  const searchHandles = useRef<Map<string, TerminalSearchHandle>>(new Map());

  /**
   * Scroll the grid the minimum needed to show all of one tile, and leave it
   * alone when the tile is already whole.
   */
  const revealTile = useCallback((id: string) => {
    const container = gridScrollRef.current;
    const target = paneElRefs.current.get(id);
    if (!container || !target) return;
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (t.top >= c.top && t.bottom <= c.bottom) return; // already fully visible
    // A tile taller than the pane can never be shown whole, so show its top and
    // stop. Without the height test it alternates: top-aligned, its bottom is
    // still past the fold, so the next call scrolls to align the bottom instead
    // and puts the header back out of reach.
    const delta =
      t.height > c.height || t.top < c.top ? t.top - c.top : t.bottom - c.bottom;
    if (delta === 0) return;
    container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
  }, []);

  // Focus follows the mouse across grid tiles, so the ring that marks the
  // active tile is also where a paste, a keystroke and Find will land.
  const gridFocus = useGridFocus({
    gridMode,
    activeId,
    resizing,
    onActivate,
    // Whether the keyboard actually arrived, which is not the same question as
    // whether it was asked for: a pane taken out of the grid is display:none,
    // and focus does not stick to something that is not being displayed.
    focusTerminal: useCallback((id: string) => {
      searchHandles.current.get(id)?.focusTerminal();
      const pane = paneElRefs.current.get(id);
      return pane !== undefined && pane.contains(document.activeElement);
    }, []),
    chromeKeyboard,
    releaseChrome: useCallback(() => setChromeKeyboard(false), []),
  });

  // When the active session changes, bring its tab into the strip, and leave
  // the strip alone when the tab is already whole.
  //
  // The pointer counts. The strip used to sit out an activation that came from
  // the mouse, on the grounds that it would slide about as the mouse swept the
  // grid; but the strip is the one place that names the session you are about
  // to type into, and with more tabs than fit, hovering a tile could leave its
  // name off the end of the strip entirely. It corrects itself now.
  //
  // How far it moves is what stops the sliding being a nuisance. A deliberate
  // pick centres its tab, so there is context either side, which is what
  // clicking a tab has always done. The pointer gets the least scroll that
  // makes the tab whole: a sweep across a wall of tiles is a run of
  // activations, and centring each one in turn would have the strip travelling
  // its own length for every tile the mouse passes over.
  useEffect(() => {
    if (activeId === null) return;
    const container = tabScrollRef.current;
    const target = tabElRefs.current.get(activeId);
    if (!container || !target) return;
    const c = container.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (t.left >= c.left && t.right <= c.right) return; // already visible
    let delta: number;
    if (gridFocus.pointerActivated.current === activeId) {
      // Nearest edge, and the left one for a tab too wide to fit at all, which
      // otherwise alternates between its two ends on every hover.
      delta =
        t.width > c.width || t.left < c.left ? t.left - c.left : t.right - c.right;
    } else {
      delta = t.left + t.width / 2 - (c.left + c.width / 2);
    }
    if (delta === 0) return;
    container.scrollTo({ left: container.scrollLeft + delta, behavior: "smooth" });
  }, [activeId, sessions, gridFocus.pointerActivated]);

  // In Grid, when the active session changes, scroll its tile just enough to be
  // fully visible in the pane area, but leave it alone if it already is.
  //
  // Unlike the strip above, this still sits out an activation that came from
  // the pointer. The strip is an index, small and off to one side, and moving
  // it to name the tile you are pointing at costs nothing; the grid is the work
  // itself, and sliding a wall of live terminals about because the mouse
  // crossed one of them is a different proposition. The tile is under the
  // cursor either way, so nothing is hidden that you cannot see by looking.
  useEffect(() => {
    if (!gridMode || activeId === null) return;
    if (gridFocus.pointerActivated.current === activeId) return;
    revealTile(activeId);
  }, [activeId, sessions, gridMode, revealTile, gridFocus.pointerActivated]);

  const [gates, setGates] = useState<Map<string, ConnectionGate>>(new Map());
  const [retryNonces, setRetryNonces] = useState<Map<string, number>>(
    new Map(),
  );

  // How far along each pane's connection is. The tab strip only needs "is it
  // up", which `connectedSessions` already answers, but Retry all needs to know
  // *why* a pane is down: a connect still in flight would be torn down by a
  // retry, and one parked at a host-key gate is waiting on a dialog the
  // operator has to answer whether or not anything is retried around it. Only
  // `failed` and `closed` are the panes actually offering a Try again button,
  // which is the set the menu acts on.
  const [phases, setPhases] = useState<Map<string, TerminalPhaseKind>>(
    () => new Map(),
  );
  const onPhaseChange = useCallback(
    (id: string, phase: TerminalPhaseKind) =>
      setPhases((prev) =>
        prev.get(id) === phase ? prev : new Map(prev).set(id, phase),
      ),
    [],
  );
  // Drop entries whose session has closed, so the map can't grow without bound
  // (the same housekeeping the grid's exclusion set does).
  // Guarded on the outcome, like the grid's exclusion set: the same map comes
  // back unless an entry was actually dropped, so this cannot write twice and a
  // render-phase update cannot loop.
  const livePhases = (() => {
    if (phases.size === 0) return phases;
    const live = new Set(sessions.map((s) => s.id));
    const next = new Map([...phases].filter(([id]) => live.has(id)));
    return next.size === phases.size ? phases : next;
  })();
  if (livePhases !== phases) setPhases(livePhases);

  // COM ports this app already has a live tab on.
  //
  // A serial port belongs to one program at a time, so a second tab on the same
  // cable can only fail, and Windows refuses it with "Access is denied", which
  // reads as a permissions problem rather than as "you already have that open".
  // Saying so in the launcher is better than explaining it in a banner
  // afterwards. Nothing has to be kept in step: an open session already carries
  // its port in its shell id.
  //
  // A pane sitting on a Try again or Reconnect banner is holding nothing, so it
  // does not count. That is the same dead-pane test Retry all uses, for the same
  // reason: the phase is what says whether a session exists as more than a tab.
  const openSerialPorts = useMemo(() => {
    const held = new Set<string>();
    for (const s of sessions) {
      if (s.type !== "local") continue;
      const phase = phases.get(s.id);
      if (phase === "failed" || phase === "closed") continue;
      const port = serialPortOf(s.shell.id);
      if (port) held.add(port);
    }
    return held;
  }, [sessions, phases]);

  /** Per-session counter for the Reset display control. Bumping one re-inits
   * that terminal's xterm view without touching the session behind it. */
  const [resetNonces, setResetNonces] = useState<Map<string, number>>(
    new Map(),
  );
  const resetDisplay = useCallback(
    (id: string) => {
      setResetNonces((prev) => new Map(prev).set(id, (prev.get(id) ?? 0) + 1));
      // Clearing our own view leaves nothing on screen until the shell prints
      // something, so the pane sits blank and you have to press Enter to get a
      // prompt back. Ctrl-L is the fix: a shell's line editor redraws the
      // prompt (and anything half-typed on it) and nothing is executed.
      //
      // Deliberately NOT Ctrl-C, which is the obvious thing to reach for and
      // the wrong one: it would turn a display-only button into one that can
      // kill a running upgrade. This one cannot. A program that has the
      // terminal treats ^L as "redraw" or ignores it; one that isn't reading
      // the tty at all (the case that put a stuck prompt on screen in the first
      // place) leaves the byte queued for the shell, which redraws its prompt
      // when it gets it. In that second case the tty also echoes the keystroke
      // as a literal `^L`, which TerminalView drops on the way in so it is
      // never drawn, and takes the queued form feed back off the line buffer,
      // because a redraw that lands minutes later clears away whatever the
      // command printed in the meantime.
      //
      // Except on Command Prompt, whose console line editor has no such
      // binding: it takes the form feed as a literal character and leaves a
      // stray glyph sitting on the command line. There the clear stands on its
      // own, which is what this button did everywhere until now.
      if (!redrawsOnFormFeed(sessions.find((s) => s.id === id))) return;
      ptyWrite(id, "\x0c").catch(() => {
        // A closed session has nothing to redraw; the local clear still stands.
      });
    },
    [sessions],
  );

  /** Per-session counter for "end this session, keep the tab". The pane does the
   * work (see TerminalView's end effect); this only says which one and when. */
  const [endNonces, setEndNonces] = useState<Map<string, number>>(new Map());
  const endSession = useCallback((id: string) => {
    setEndNonces((prev) => new Map(prev).set(id, (prev.get(id) ?? 0) + 1));
  }, []);

  // PTY Find (D-015, Find only; filtering live interactive output is
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

  const activeHandle = useCallback(
    () => (activeId !== null ? searchHandles.current.get(activeId) : undefined),
    [activeId],
  );

  // The pane Find last painted matches into. Now that the search highlights
  // them, a pane has to be told when the bar has moved on: otherwise the tab
  // you searched keeps its matches lit, and its addon keeps re-sweeping the
  // buffer for them every time the shell there goes quiet.
  const searchedPane = useRef<string | null>(null);
  const clearLastSearched = useCallback(() => {
    const id = searchedPane.current;
    if (id === null) return;
    searchedPane.current = null;
    searchHandles.current.get(id)?.clearSearch();
  }, []);

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
    clearLastSearched();
    activeHandle()?.clearSearch();
    activeHandle()?.focusTerminal();
  }, [activeHandle, clearLastSearched]);

  // Switching tabs while searching: re-run the query against the new pane, and
  // take the highlights off the one being left.
  //
  // The count is dropped during render, so the effect below is left doing only
  // what an effect is for here, which is reaching into the terminals. Without
  // it the bar reads "3 of 17" against a pane those hits do not belong to until
  // the new search answers.
  const [prevActiveForSearch, setPrevActiveForSearch] = useState(activeId);
  if (prevActiveForSearch !== activeId) {
    setPrevActiveForSearch(activeId);
    if (searchOpen && searchQuery) setSearchResults(null);
  }
  useEffect(() => {
    if (!searchOpen || !searchQuery) return;
    clearLastSearched();
    if (searchQuery.pattern && activeId !== null) {
      activeHandle()?.findNext(searchQuery.pattern, searchQuery.options, true);
      searchedPane.current = activeId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const handleQueryChange = (pattern: string, options: SearchOptions) => {
    setSearchQuery({ pattern, options });
    if (pattern && activeId !== null) {
      activeHandle()?.findNext(pattern, options, true);
      searchedPane.current = activeId;
    } else {
      clearLastSearched();
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

  const searchFailed = searchResults !== null && searchResults.count < 0;
  const searchStatus = (() => {
    if (!searchQuery?.pattern || !searchResults) return "";
    // -1 is TerminalView's sentinel for "the search threw", which is a different
    // thing from finding nothing and has to read as one.
    if (searchFailed) return "Search failed";
    if (searchResults.count === 0) return "No matches";
    // "3 of 17", so Up and Down have somewhere to count from. The index is -1
    // when the active match is not one of the ones the addon is tracking, which
    // is what happens past its 1000-match highlight limit; there is no honest
    // position to report then, only the total.
    return searchResults.index >= 0
      ? `${searchResults.index + 1} of ${searchResults.count}`
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

  // Clearing the gate on dialog close (cancel OR accept, the dialogs close
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

  // Every pane currently showing a Try again / Reconnect button: a connect that
  // was refused, and a session whose shell went away. Both have the same remedy
  // and the same button on the pane, so "retry everything that is offering a
  // retry" is one idea rather than two.
  //
  // Deliberately NOT "everything the tab strip paints red". That set also holds
  // panes mid-connect, which a retry would abort and start over, and panes
  // holding a host-key dialog, which are not waiting on a retry but on an
  // answer. Both would look like the button had done nothing, or worse.
  // The sessions with a shell actually behind them right now, which is the only
  // set "end this session" applies to. Not the complement of `retryableIds`:
  // that leaves out panes mid-connect and panes holding a host-key dialog, and
  // neither has a shell to end yet.
  const openIds = useMemo(
    () =>
      new Set(
        sessions.filter((s) => phases.get(s.id) === "open").map((s) => s.id),
      ),
    [sessions, phases],
  );

  const retryableIds = useMemo(
    () =>
      sessions
        .filter((s) => {
          const p = phases.get(s.id);
          return p === "failed" || p === "closed";
        })
        .map((s) => s.id),
    [sessions, phases],
  );
  // One pass, no stagger. Each retry is a state bump that React batches, and the
  // connects that follow are no heavier than the launcher's own "open N at
  // once", which the same operator can already fire from the + menu.
  const retryAll = () => {
    for (const id of retryableIds) reconnectSession(id);
  };
  // The other answer to the same set. Close all asks first because it can take
  // away work in progress; this cannot, since every tab it touches has already
  // lost its shell, so a confirmation would only be a step between the operator
  // and a tidy-up they have already decided on.
  const closeFailed = () => {
    for (const id of retryableIds) closeSession(id);
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
      // Not the page's own onActivate: keyboard navigation outranks a resting
      // cursor (without that, Alt+Left lands on the right tab and the next
      // nudge of the mouse takes it back) and in a grid it has to carry the
      // keyboard with it, since every pane is on screen and none of them will
      // take it by itself.
      gridFocus.activateDeliberately(sessions[nextIdx]!.id);
    },
    [sessions, activeId, gridFocus],
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

  // Show the gate dialog for the active session only, switching tabs while
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
   * PTY tabs bypass the guard by design (D-014): the operator is
   * interactive here, same as if they typed it themselves. */
  const runShortcut = (cmd: string) => {
    if (activeId === null) return;
    const target = activeId;
    // Submit with a carriage return (\r), the byte a real Enter keypress sends.
    // Windows ConPTY shells (PowerShell/cmd) need \r to execute; \n leaves the
    // line at a ">>" continuation prompt. \r is also correct for SSH/WSL.
    ptyWrite(target, cmd + "\r").catch((e) => {
      toast.error(errorMessage(e));
    });
    // The command has gone to a terminal, so the keyboard goes with it. Go is
    // not somewhere to stay: pressing it leaves DOM focus on the button, and
    // the next thing anyone does is read or answer what the command printed.
    // Without this the keyboard sat in the strip and the only way back into
    // the pane was to click it, which is a poor reward for using the toolbar.
    setChromeKeyboard(false);
    searchHandles.current.get(target)?.focusTerminal();
  };

  return (
    <div className="relative flex h-full flex-col">
      {/* Chrome (controls + tab strip) is hidden while a terminal is maximized:
          only the terminal pane and the AppShell banner remain.

          In grid fullscreen the same chrome stays, but slides up out of the way
          until only a small tab shows at the top centre, and slides back down
          when the pointer reaches that tab (or clicks it), or Ctrl+Shift+T asks
          for it.
          Anything clicked in it sends it away again: it is somewhere to go and
          do one thing, not a bar that waits to be dismissed. It is positioned
          out of flow, so the tiles get the whole window.
          Deliberately a transform rather than a height animation with
          overflow-hidden: the "+" launcher's dropdown has to be able to escape
          the strip. */}
      {!maximized && (
        <div
          ref={chromeRef}
          onKeyDown={onChromeKeyDown}
          // A click is the mouse taking over: drop the keyboard mark so the
          // ring goes away and Tab stops wrapping.
          onPointerDown={() => setChromeKeyboard(false)}
          // And so does focus leaving the strip by any other route (a dialog,
          // a click into a tile, navigating away).
          onBlur={(e) => {
            const to = e.relatedTarget as Element | null;
            if (e.currentTarget.contains(to)) return;
            // Except into a menu opened from here. That menu is portalled to
            // the body, so focus entering it reads as focus leaving the strip,
            // and it is not: the same person is still working these controls.
            // In fullscreen this flag is what holds the strip on screen, so
            // clearing it here would take the strip away the instant a
            // keyboard user picked something out of the menu, leaving the
            // focus ring on a control that had slid off the top.
            if (to?.closest("[role=menu],[role=listbox]")) return;
            setChromeKeyboard(false);
          }}
          // A click in here has been acted on, so in fullscreen the strip has
          // done its job and goes, even though the pointer is still on it.
          //
          // On click rather than pointerdown, so that dragging a tab to reorder
          // it does not count: a drag ends without a click. Text fields are the
          // one exception, because clicking into the tab-rename box is the
          // start of typing rather than the end of a job, and the strip has to
          // still be there to type into. The reveal tab is the other, and for
          // the opposite reason: it is not in the strip to be used, it is how
          // you got here, and clicking it rather than hovering it would take
          // the strip straight back up again. Menus need no exception:
          // clicking a trigger marks the strip dismissed, but data-state holds
          // it open until the menu closes, which is exactly when it should go.
          //
          // What puts it back in play is the pointer arriving from outside, in
          // the tracker above. There is deliberately no mouse-leave handler
          // here: leaving is the edge an inert body can invent, and this latch
          // is the one thing in here that can beat every holder at once.
          onClick={(e) => {
            const el = e.target as Element | null;
            if (el?.closest("input,textarea,[contenteditable],[data-strip-tab]"))
              return;
            setStripDismissed(true);
          }}
          data-chrome-keyboard={chromeKeyboard ? "1" : undefined}
          data-strip-hover={
            gridFullscreen && stripHover && !stripDismissed ? "1" : undefined
          }
          className={cn(
            // `terminal-chrome` is the hook for the loud focus ring (index.css).
            // Ctrl+Shift+T is the only way into these controls from a terminal,
            // so where it landed has to be obvious; the default ring is a grey
            // at half opacity on a grey strip, and it was not.
            "terminal-chrome",
            gridFullscreen &&
              // has-[[data-state=open]] is what keeps the strip down while a
              // menu opened from it is up, and it is not a nicety: without it
              // the strip slid away the moment a menu opened and took the menu
              // with it, half off the top of the screen.
              //
              // Neither of the other two triggers can hold it. A Radix menu is
              // modal, so opening one puts pointer-events:none on the body and
              // :hover goes false even with the mouse sitting still; and its
              // content is portalled to the body, so focus moving into it is
              // focus leaving this element and :focus-within goes false too.
              // The trigger keeps data-state="open" for exactly as long as the
              // menu is up, which is the one signal that survives both. Written
              // against the attribute rather than a piece of React state so it
              // covers every menu and select in the strip, including the "+"
              // launcher in the tab row below, with nothing to keep in sync.
              //
              // Note what is NOT a holder: focus. It used to be, as a plain
              // focus-within, and that is what made the strip blink after a
              // menu selection. Picking an item ends the data-state hold at
              // once, the mouse is down where the menu was rather than on the
              // strip, and focus is briefly on nothing at all, because Radix
              // hands it back to the trigger from inside a setTimeout(0)
              // (react-focus-scope, dodging a React 16 unmount bug). So the
              // strip set off up the screen and focus-within dragged it back.
              //
              // Focus is the wrong thing to ask anyway. Radix returning focus
              // to a trigger is tidying up, not the operator asking to see the
              // controls, and treating it as a request is what kept the strip
              // on screen after the work was done. The two real requests are
              // the pointer being here and the keyboard having been sent here
              // by Ctrl+Shift+T, and data-chrome-keyboard is set by that
              // shortcut itself rather than inferred: see the effect that
              // handles it for why :focus-visible cannot be trusted to notice
              // programmatic focus.
              //
              // The strip goes all the way off the top, plus a pixel. It used
              // to stop 6px short so a sliver stayed on screen to hover, which
              // made the entire width of the top edge a live target in the one
              // mode whose whole point is to give the screen to the terminals:
              // any flick of the mouse towards the top pulled the controls
              // down over the top row of tiles. What reaches over the edge now
              // is the tab below, and only the tab. The extra pixel is because
              // a box whose bottom edge lands exactly on y=0 can still be hit
              // at y=0 once display scaling has rounded it; a pixel of clear
              // air is cheaper than finding that out on a 125% display.
              //
              // There is no transition-delay in here, and for a while there
              // was, which is worth saying out loud. It was a debounce over the
              // painted frame in which a closing menu has given up its
              // data-state hold and has not yet given the body back, leaving
              // :hover false with the pointer sitting on the strip. Being a
              // guess at the length of a frame it did not reliably cover it,
              // and it made everyone wait on the way out for a case that only
              // arises when a menu closes. `data-strip-hover` measures the
              // pointer instead and answers straight through that frame, so
              // there is nothing left to wait for.
              "absolute inset-x-0 top-0 z-40 -translate-y-[calc(100%+1px)] border-b border-border bg-background shadow-lg transition-transform duration-150 data-chrome-keyboard:translate-y-0 has-[[data-state=open]]:translate-y-0 data-strip-hover:translate-y-0",
            // The pointer being here is the holder a click switches off, and
            // both of the ways of knowing it are switched off together: the
            // measured one loses its attribute below, and :hover is dropped
            // from the class list rather than fought with a more specific rule,
            // because "is the pointer still a reason to be here" is a question
            // React already knows the answer to. The other two survive a click
            // on purpose: an open menu still has to be attached to something,
            // and a keyboard sent here by Ctrl+Shift+T is not finished just
            // because it pressed Enter on a button.
            gridFullscreen && !stripDismissed && "hover:translate-y-0",
          )}
        >
      <TerminalRail
        tabsCompact={tabsCompact}
        toggleTabsCompact={toggleTabsCompact}
        layout={layout}
        chooseLayout={chooseLayout}
        broadcastRail={broadcastRail}
        toggleBroadcastRail={toggleBroadcastRail}
        gridMode={gridMode}
        sizeIsPinned={sizeIsPinned}
        resetTileSize={resetTileSize}
        gridFullscreen={gridFullscreen}
        onGridFullscreen={onGridFullscreen}
        maximizeActive={() => {
          if (activeId !== null) onMaximize(activeId);
        }}
        hideGridHeaders={hideGridHeaders}
        toggleGridHeaders={toggleGridHeaders}
        customGrid={customGrid}
        gridCount={gridCount}
        twoUpSplit={twoUpSplit}
        toggleTwoUpSplit={toggleTwoUpSplit}
        activeId={activeId}
        resetDisplay={resetDisplay}
        shortcuts={shortcuts}
        activeScope={activeScope}
        runShortcut={runShortcut}
        onManageShortcuts={onManageShortcuts}
        sessions={sessions}
        tabSuffix={tabSuffix}
        // Picking from the Sessions menu is as deliberate as clicking a tab,
        // and as much a request to work there.
        onActivate={gridFocus.activateDeliberately}
        openIds={openIds}
        onEndSession={endSession}
        onCloseAll={() => setCloseAllOpen(true)}
        retryableCount={retryableIds.length}
        onRetryAll={retryAll}
        onCloseFailed={closeFailed}
        hiddenCount={excludedFromGrid.size}
        onUnhideAll={clearGridExcluded}
      />

      {/* Tab strip on its own line below the controls. The row itself does NOT
          scroll/clip, only the inner tab list does, so the "+" launcher's
          dropdown (which opens downward, below the strip) isn't clipped by an
          overflow container. (overflow-x:auto forces overflow-y to compute to
          auto too, which silently cropped the menu and made "+" look dead.) */}
      <div className="flex items-center gap-1 border-b border-border/50 px-2 pt-2">
        <div
          ref={tabScrollRef}
          role="tablist"
          onKeyDown={onTabStripKeyDown}
          onBlur={(e) => {
            // Coming back to the strip later should land on the active tab
            // again, not wherever the arrows were last left pointing.
            if (!e.currentTarget.contains(e.relatedTarget)) setTabStopId(null);
          }}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          // Whether this tab holds the strip's one Tab stop, for itself and for
          // the little buttons inside it.
          const isTabStop = s.id === rovingTabId;
          const stopIndex = isTabStop ? 0 : -1;
          // A remote tab that's open but not connected (connecting, dropped or
          // failed) reads as disconnected; local shells never are.
          const disconnected =
            s.type === "ssh" && !connectedSessions.has(s.id);
          // The colour this tab wears: a host's, a shell kind's, or a profile's.
          // Local tabs used to have none of these and were all the same grey,
          // which is fine with two open and no help at all with ten.
          const tabColor = sessionColor(s, shellColors);
          // The active tab tints with that colour when it has a usable one and
          // is not a remote session that has lost its connection. Anything left
          // over falls back to a theme-aware fill (bg-accent) with the
          // foreground colour as the bar.
          const hostTint = isActive && !disconnected && isTintable(tabColor);
          // ~20% alpha body fill + a full-strength top bar in the tab colour;
          // the theme-aware fallback just paints the 2px top bar. The top bar
          // rides the reserved transparent top border so nothing shifts. Set
          // inline (not via a border-t-* class) so it beats border-border/60.
          const activeStyle: React.CSSProperties | undefined = !isActive
            ? undefined
            : hostTint
              ? { backgroundColor: `${tabColor}33`, borderTopColor: tabColor! }
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
            onClick={() => {
              // A tab click is a deliberate choice, and the mouse is over the
              // strip rather than the grid. It holds until the pointer moves
              // off whichever tile it happens to be resting on, and the
              // keyboard goes to the tile it names: in Tabs the pane that
              // becomes visible takes it anyway, so this is the grid catching
              // up with what clicking a tab has always done.
              gridFocus.activateDeliberately(s.id);
            }}
            onKeyDown={(e) => {
              // The tab itself, not the rename box or one of the little buttons
              // that live inside it: those have their own use for Enter.
              if (e.target !== e.currentTarget) return;
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              gridFocus.activateDeliberately(s.id);
            }}
            role="tab"
            // One Tab stop for the whole strip, walked with the arrow keys from
            // there. Without this the tabs were the one thing in the row the
            // keyboard could not reach at all: they are divs, so Tab went
            // straight past them into the per-tab buttons, and the only ways to
            // change session without a mouse were Alt+arrow and the Sessions
            // menu. It also puts the case this page is built around within
            // reach of a test: choosing a session while the pointer sits still
            // over a different tile.
            tabIndex={stopIndex}
            aria-selected={s.id === activeId}
            title={tabsCompact ? `${sessionLabel(s)}${tabSuffix.get(s.id)}` : undefined}
          >
            {s.type === "ssh" ? (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: s.host.color }}
              />
            ) : (
              // The icon carries the colour on a local tab, rather than a dot
              // beside it: the icon is already there and already says which
              // shell this is, so colouring it costs no width in a strip that
              // has none to give, and an inactive tab still shows its colour
              // where the tint (active tabs only) cannot.
              <LocalShellIcon
                kind={s.shell.kind}
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  !isTintable(tabColor) && "text-muted-foreground",
                )}
                style={isTintable(tabColor) ? { color: tabColor } : undefined}
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
                // group-focus-within, not just group-hover: these buttons are in
                // the tab order, and a ring around something invisible tells you
                // nothing about where the keyboard is.
                className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-focus-within:opacity-100 group-hover:opacity-100"
                // Only for the tab holding the strip's stop. The mouse can
                // still reach every one of them.
                tabIndex={stopIndex}
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
                    : "text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
                )}
                tabIndex={stopIndex}
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
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-focus-within:opacity-100 group-hover:opacity-100"
              tabIndex={stopIndex}
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
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-focus-within:opacity-100 group-hover:opacity-100"
              tabIndex={stopIndex}
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
            // Hand-rolled, so it has to say what Radix's triggers say for
            // itself: the fullscreen chrome strip stays down for as long as
            // anything inside it reports data-state="open". Hovering already
            // held the strip for this one (the menu is a child of the strip
            // rather than a portal, so the mouse never leaves it), but the
            // keyboard did not, and one rule for every menu beats two.
            data-state={shellMenuOpen ? "open" : "closed"}
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
                    {/* The box is sized for the widest count it will ever hold
                        (three digits plus the spinner), and the reset sits
                        against it rather than out by the cap, so the pair reads
                        as one control. */}
                    <input
                      id="shell-count"
                      type="number"
                      min={1}
                      max={maxShells}
                      value={shellCount}
                      onChange={(e) => setShellCount(e.target.value)}
                      className="w-14 rounded border border-input bg-background px-1.5 py-0.5 text-center font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => setShellCount("1")}
                      disabled={shellCount === "1"}
                      aria-label="Reset the count to 1"
                      title="Back to 1"
                      {...hint("Set the number of copies to open back to 1")}
                      className="-ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                    >
                      <RotateCcwIcon className="h-3 w-3" />
                    </button>
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
                        // The colour the tab will come out, so the launcher
                        // shows the same thing the tab strip will: the
                        // profile's own if it set one, otherwise its shell's.
                        const profileColor =
                          p.color || shellColors[shell?.kind ?? ""] || null;
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
                                className={cn(
                                  "h-3.5 w-3.5 shrink-0",
                                  !isTintable(profileColor) &&
                                    "text-muted-foreground",
                                )}
                                style={
                                  isTintable(profileColor)
                                    ? { color: profileColor }
                                    : undefined
                                }
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
              {/* Serial consoles. A COM port is not a shell and does not
                  belong in the list above: nothing is spawned, there is no
                  working directory, and the port is exclusive, so "how
                  many" cannot apply to it. Its own group, listed fresh
                  every time this menu opens.

                  The speed sits on the row rather than above the list
                  because it belongs to the port, not to the session you are
                  about to start: two cables in the same machine routinely
                  want different speeds, and what each one wanted last time
                  is the answer you want offered. */}
              <div className="mt-1 border-t border-border/60 pt-1">
                <div className="px-2 py-1">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Serial console
                  </span>
                </div>
                {serialPorts.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    No COM ports found. Plug in a console cable or USB serial
                    adapter and open this menu again.
                  </p>
                ) : (
                  serialPorts.map((p) => {
                    const alreadyOpen = openSerialPorts.has(p.name);
                    return (
                    <div
                      key={p.name}
                      className="group flex items-center gap-1 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                    >
                      <button
                        type="button"
                        disabled={alreadyOpen}
                        onClick={() => openSerial(p)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                        {...hint(
                          alreadyOpen
                            ? `${p.name} is already open in a tab. A COM port belongs to one program at a time, so close that tab before opening it again.`
                            : `Open a terminal on ${p.name} at ${
                                serialBauds[p.name] ?? DEFAULT_BAUD
                              } baud, 8N1. Nothing appears until the device says something, so press Enter if the pane looks empty.`,
                        )}
                      >
                        <LocalShellIcon
                          kind="serial"
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0">
                          <span className="block truncate">
                            {p.name}
                            {alreadyOpen && (
                              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                                already open
                              </span>
                            )}
                          </span>
                          {p.description && (
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {p.description}
                            </span>
                          )}
                        </span>
                      </button>
                      {/* A native select: this menu is a hand-rolled div
                          rather than a portalled one, so there is no focus
                          or layering to fight. */}
                      <select
                        value={serialBauds[p.name] ?? DEFAULT_BAUD}
                        disabled={alreadyOpen}
                        onChange={(e) =>
                          setSerialBauds((prev) => ({
                            ...prev,
                            [p.name]: Number(e.target.value),
                          }))
                        }
                        aria-label={`Line speed for ${p.name}`}
                        title="Line speed (baud)"
                        className="shrink-0 rounded border border-input bg-background px-1 py-0.5 font-mono text-xs disabled:opacity-50"
                      >
                        {BAUD_RATES.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                    </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {/* The tab: the only part of the strip left on screen when it is slid
          up, and the only part of it a pointer can reach. It hangs off the
          strip's bottom edge rather than sitting inside it, so when the strip
          is up the tab is what pokes out below the top of the window.

          A child of the strip, not a sibling, and that is the whole trick.
          Hovering the tab is hovering the strip, so `hover:translate-y-0`
          above needs nothing added to it; and the pointer crossing from tab to
          strip and back is movement within one element, so it fires no
          mouse-leave and cannot flicker at the seam. The dismissal latch gets
          the same for free: after a click sends the strip away, a pointer left
          sitting on the tab has never left the strip, so the latch stays set
          and the strip stays up until the pointer actually goes somewhere
          else. That is what "does not come back unless you move back to it"
          means when the pointer never moved.

          Big enough to aim at, and no bigger: every pixel of it is a pixel of
          the top tile covered. It sits on the top edge of the window, so there
          is no vertical aim to get wrong; only the horizontal, and 192px in
          the middle of the screen is a target you can find without looking.
          The full width of the edge is not needed for that and cost too much
          (see the strip's own class list).

          20px tall for 18 on screen, three times the 6px sliver it replaces.
          Two go missing: `top-full` is the strip's padding box, so the tab
          starts a border inside it, and the strip itself is lifted by the
          pixel of clear air described above.

          Part-transparent, because it is parked over the top of a terminal for
          as long as fullscreen lasts and there is no reason for it to take
          those characters away. The border and the grabber are what carry the
          shape, so the fill can afford to be thin: they stay at full strength
          and it is only the panel behind them that lets the text through.
          Hover fills it in, which doubles as the acknowledgement that the
          pointer arrived.

          The same at rest whether the strip is up or down, rather than solid
          while the strip is out. It could be told apart, but only by naming
          all three of the things that hold the strip down a second time over
          here, and a copy of that list is a copy that can fall out of step
          with the original. The tab is 20px of flap under a bar that is
          already covering a hundred, so there is nothing under it worth
          reading at that moment anyway.

          It takes clicks as well as hovers, and the click is not just there to
          be obliging. A click in the strip latches it away until the pointer
          arrives from somewhere else, and the one place a pointer can be left
          that it never has to arrive at is this tab, because the tab follows
          the strip up and parks itself under the pointer that clicked it. From
          there hovering is a no-op and clicking is what the hand does next, so
          that is what clears the latch. Kept a div rather than a button on
          purpose: it would otherwise become a Tab stop in a strip whose tab
          order is walked deliberately, and it is the one control here with a
          keyboard equivalent that needs no aim at all. */}
      {gridFullscreen && (
        <div
          ref={stripTabRef}
          data-strip-tab=""
          onClick={() => {
            stripHoverRef.current = true;
            setStripHover(true);
            setStripDismissed(false);
          }}
          className="absolute left-1/2 top-full flex h-5 w-48 -translate-x-1/2 cursor-pointer items-center justify-center rounded-b-md border border-t-0 border-border bg-background/50 shadow-md transition-colors hover:bg-accent"
          title="Hover or click here to show the controls, or press Ctrl+Shift+T to put the keyboard in them"
        >
          <div className="h-1 w-24 rounded-full bg-muted-foreground/70" />
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
          statusTone={searchFailed ? "error" : "normal"}
          onQueryChange={handleQueryChange}
          onNavigate={handleNavigate}
          onClose={closeSearch}
        />
      )}

      {/* In tabs mode one pane fills the area and the rest are display:none.
          In grid mode every pane tiles at once, mirroring the skill run panel.
          The pane wrappers keep the same key and structure in both modes (the
          header is present-but-hidden in tabs), so switching layout only
          restyles them, it never remounts a TerminalView, which would tear
          down its live PTY. */}
      {/* The rail sits beside the panes rather than above them, so turning it on
          costs width (of which there is plenty) and not the vertical space the
          terminals want. */}
      <div className="flex min-h-0 flex-1">
      {broadcastRail && (
        <div className="w-56 shrink-0">
          <BroadcastRail
            sessions={sessions}
            connectedSessions={connectedSessions}
            visible={visible}
          />
        </div>
      )}
      <div
        ref={gridScrollRef}
        className={cn(
          "min-h-0 min-w-0 flex-1 bg-[var(--terminal-bg)] p-2",
          // overflow-hidden: the pane must exactly fill this area, so clip any
          // transient xterm mis-size (e.g. a font change applied while the page
          // was hidden restyles .xterm-screen before a fit can run) instead of
          // letting it push AppShell's overflow-auto <main> into scrolling the
          // controls row + tab strip off screen.
          !gridMode && "relative overflow-hidden",
          // Settings-driven grid (Settings -> Grid): a uniform layout with pinned
          // columns and/or character-based tile size. Overflow scrolls, the
          // fixed widths can exceed the viewport, and that scroll is intended.
          customGrid && "grid content-start gap-2 overflow-auto",
          // Default fit-to-viewport grid, sized to the number of open terminals:
          //  1 tile  → fills the whole area,
          //  2 tiles → split full-height (two columns wide, stacked when the
          //            pane is too narrow for two readable ones),
          //  3+ tiles → tile two-across, rows sharing the height until they
          //             reach a comfortable minimum, then scrolling.
          // Every track comes from gridStyle rather than a class. The classes
          // said `lg:grid-cols-2`, a media query on the window, which cannot
          // see that the sidebar and the broadcast rail come out of this pane.
          !customGrid && gridMode && gridCount <= 2 && "grid gap-2",
          !customGrid && gridMode && gridCount > 2 && "grid gap-2 overflow-auto",
        )}
        style={gridStyle}
      >
        {/* Every tile hidden but terminals still open: say so, or the grid
            reads as broken. The way out is offered here rather than only
            described, because the tabs this text sends you to are precisely the
            ones whose eye buttons you would have to find one at a time, and
            this is the state where that is most tedious.

            Centred in the empty area, and stacked, rather than a row along the
            top edge. This is the only thing on screen in this state, so the
            eye has nothing else to land on and no reason to be sent to a
            corner; and read as one line the sentence, the button and the
            second sentence ran together into something that looked like prose
            with a control stuck in the middle of it. Three lines make the
            button the middle of the three rather than an interruption. */}
        {gridMode && gridCount === 0 && sessions.length > 0 && (
          <div className="col-span-full flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-muted-foreground">
            <span>Every terminal is hidden from the grid.</span>
            <Button size="sm" variant="outline" onClick={clearGridExcluded}>
              <Grid2x2Icon className="h-3.5 w-3.5" />
              Unhide all ({excludedFromGrid.size})
            </Button>
            <span>Or use the grid button on a tab to bring back just one.</span>
          </div>
        )}
        {paneOrder.map((s) => {
          const isActive = s.id === activeId;
          // Taken out of the grid from its tab. The pane stays mounted (and its
          // shell alive); it is simply not laid out.
          const excluded = gridMode && excludedFromGrid.has(s.id);
          const disconnected = s.type === "ssh" && !connectedSessions.has(s.id);
          // The active tile's header mirrors the tab tint: a ~20% fill in the
          // tab's colour and a top bar in it, falling back to the theme accent
          // (with a foreground top bar) for tiles with no usable hue, which now
          // means a dropped remote or a shell whose colour has been cleared.
          const tabColor = sessionColor(s, shellColors);
          const hostTint = isActive && !disconnected && isTintable(tabColor);
          const headerStyle: React.CSSProperties | undefined = !isActive
            ? undefined
            : hostTint
              ? { backgroundColor: `${tabColor}33`, borderTopColor: tabColor! }
              : { borderTopColor: "var(--foreground)" };
          // Selected tile outlined in its own identifying colour (border + a
          // matching soft ring) instead of the theme primary. Only where there
          // is a usable hue; a dropped remote, or a shell whose colour has been
          // cleared, falls back to the primary classes below.
          const tileStyle: React.CSSProperties | undefined = !gridMode
            ? undefined
            : {
                // Visual position in the grid = position in the tab strip, so
                // dragging a tab rearranges the grid. See displayIndex.
                order: displayIndex.get(s.id) ?? 0,
                // The legible floor for the default grid at 3+ tiles, the same
                // number its row track is floored at (see tileMinH). Inline
                // rather than a `min-h-[16rem]` class on purpose: rem follows
                // the app font and the track is in px, so as a class the two
                // drifted apart and the tiles overlapped. A custom grid's
                // rows are already sized by Settings, and one or two tiles
                // always fill the pane, so neither takes a floor.
                ...(!customGrid && gridCount > 2 ? { minHeight: tileMinH } : {}),
                // Filling a short last row (Settings -> Grid). Nothing for most
                // tiles; a span for the ones that take up the slack.
                ...(excluded ? {} : tileSpan(gridSlot.get(s.id) ?? 0)),
                ...(hostTint
                  ? {
                      borderColor: tabColor!,
                      boxShadow: `0 0 0 1px ${tabColor}66`,
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
              // The one hook the stylesheet has on "this is the live tile".
              // A host-tinted tile takes its ring from tileStyle above, as
              // inline colours no class can name, so muting it while the window
              // is asleep has nothing else to aim at. See the
              // [data-window-blurred] rules in index.css.
              data-tile-active={gridMode && isActive ? "" : undefined}
              className={cn(
                gridMode
                  ? excluded
                    ? "hidden"
                    : cn(
                      // relative: anchors the resize handles below.
                      "relative flex min-w-0 flex-col overflow-hidden rounded-md border",
                      // Row height comes from the row track (a pinned
                      // item-height, or minmax(floor, 1fr) when auto), so the
                      // tile just fills it. The default grid's legible floor
                      // for 3+ tiles rides in tileStyle instead, in the same
                      // pixels the track was floored with.
                      "min-h-0",
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
              {...(gridMode ? gridFocus.tileProps(s.id) : {})}
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
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      !isTintable(tabColor) && "text-muted-foreground",
                    )}
                    style={
                      isTintable(tabColor) ? { color: tabColor } : undefined
                    }
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
                  // box to fit to, tell it so, exactly as a background tab in
                  // tabs mode is told, or it would fit against a zero size.
                  visible={visible && (gridMode ? !excluded : isActive)}
                  retryNonce={retryNonces.get(s.id) ?? 0}
                  resetNonce={resetNonces.get(s.id) ?? 0}
                  endNonce={endNonces.get(s.id) ?? 0}
                  onGate={handleGate}
                  onClosed={closeSession}
                  onReconnect={reconnectSession}
                  onSearchRequest={() => setSearchOpen(true)}
                  onTabNav={navTab}
                  onSearchResults={(index, count) =>
                    setSearchResults({ index, count })
                  }
                  onConnectionChange={onConnectionChange}
                  onPhaseChange={onPhaseChange}
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
                    data-resize-handle=""
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
                    data-resize-handle=""
                    className="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize hover:bg-primary/40"
                  />
                  <div
                    onMouseDown={(e) =>
                      beginResize(e, "both", paneElRefs.current.get(s.id) ?? null)
                    }
                    role="separator"
                    aria-label="Drag to set the size of every grid tile"
                    title="Drag to set the size of every tile"
                    data-resize-handle=""
                    className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize hover:bg-primary/50"
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
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
            <AlertDialogTitle>
              {bulkConfirm?.opts?.startupCommand
                ? "Run the startup command in every copy?"
                : "Open that many shells?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              You're about to open{" "}
              <span className="font-semibold text-foreground">
                {bulkConfirm?.count}{" "}
                {bulkConfirm?.opts?.profileLabel ?? bulkConfirm?.shell.label}
              </span>{" "}
              {bulkConfirm?.opts?.startupCommand ? (
                <>
                  terminals, and this profile types its startup command into
                  each one. That command will run{" "}
                  <span className="font-semibold text-foreground">
                    {bulkConfirm?.count} times
                  </span>
                  . Continue?
                </>
              ) : (
                <>
                  terminals at once. That's a lot of shells, and each one is a
                  live process. Continue?
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // Pass the stored opts through: a confirmed profile batch must
                // keep its cwd / startup command / name, same as an unconfirmed
                // one.
                if (bulkConfirm)
                  openShells(
                    bulkConfirm.shell,
                    bulkConfirm.count,
                    bulkConfirm.opts,
                  );
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
