import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AppShell, type Page } from "@/components/AppShell";
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
import { isExitGuardEnabled } from "@/lib/exitGuard";
import { HostsPage } from "@/pages/HostsPage";
import { BroadcastPage } from "@/pages/BroadcastPage";
import {
  TerminalsPage,
  type TermSession,
  type SshTermSession,
  type LocalShellOpenOpts,
} from "@/pages/TerminalsPage";
import type { LocalShell } from "@/lib/tauri/local";
import { PtyBroadcastPage } from "@/pages/PtyBroadcastPage";
import { MultiTerminalPage } from "@/pages/MultiTerminalPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { SftpPage } from "@/pages/SftpPage";
import { LogsPage } from "@/pages/LogsPage";
// Settings (~2k lines) and Help (static docs) mount only when their tab is
// active, so they are code-split into their own chunks to shrink the initial
// bundle the app parses on launch (perf: slow cold start in the packaged exe).
const SettingsPage = lazy(() =>
  import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const HelpPage = lazy(() =>
  import("@/pages/HelpPage").then((m) => ({ default: m.HelpPage })),
);
import { UnlockDialog } from "@/components/UnlockDialog";
import { SettingsLoading } from "@/components/SettingsLoading";
import { Toaster } from "@/components/ui/sonner";
import { StatusProvider } from "@/components/StatusProvider";
import { UiPrefsProvider } from "@/components/UiPrefsProvider";
import {
  type Host,
  isCredentialsUnlocked,
  requiresMasterPassword,
} from "@/lib/tauri/hosts";
import { onPtySudo, onPtySudoRejected } from "@/lib/tauri/pty";

function App() {
  const [page, setPage] = useState<Page>("hosts");
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [sessions, setSessions] = useState<TermSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Monotonic creation counter: stamps each new tab with a stable `seq` so the
  // duplicate suffix and pane order survive drag-reordering. Never resets.
  const seqRef = useRef(0);
  const nextSeq = useCallback(() => seqRef.current++, []);
  // Session ids with a live PTY connection (drives Hosts connected dots).
  const [connectedSessions, setConnectedSessions] = useState<Set<string>>(
    new Set(),
  );
  // Set when "Manage shortcuts…" is picked — Settings scrolls there on open.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  // Latch: once Settings has been opened it stays mounted (hidden) like the
  // other heavy pages, so re-visiting it doesn't pay the ~5s cost of remounting
  // its large Radix tree every time. The lazy chunk still loads only on first
  // open (kept out of the startup payload); after that the page persists.
  const [settingsMounted, setSettingsMounted] = useState(false);
  // True once Settings has mounted AND loaded its data — drives whether we show
  // the branded loader over the tab. Pre-warming (below) usually flips this
  // before the user ever clicks Settings, so the loader is rarely seen.
  const [settingsReady, setSettingsReady] = useState(false);
  const handleSettingsReady = useCallback(() => setSettingsReady(true), []);
  // Maximized terminal: the id of the session filling the whole window (null =
  // normal view). Tracking the id (not a bool) lets us drop back to the tabbed
  // view automatically when that specific terminal is closed.
  const [maxSessionId, setMaxSessionId] = useState<string | null>(null);
  const maximized = maxSessionId !== null;

  // Exit guard (opt-in, on by default): warn before the window closes while any
  // terminal is still connected, so a stray Alt+F4 doesn't drop live sessions.
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  // The close handler is registered once but must see the live connection set
  // and toggle state, so both are read through refs the effects keep current.
  const connectedRef = useRef<Set<string>>(connectedSessions);
  useEffect(() => {
    connectedRef.current = connectedSessions;
  }, [connectedSessions]);
  // Latched true once the user confirms the quit, so our own destroy() isn't
  // re-intercepted by the guard.
  const closingRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const needsMaster = await requiresMasterPassword();
        if (!needsMaster) return;
        const unlocked = await isCredentialsUnlocked();
        if (!unlocked) setUnlockOpen(true);
      } catch {
        // App still works without unlock; the user just can't set credentials
        // until they try and get prompted.
      }
    })();
  }, []);

  // Sudo auto-fill transparency (D-065): toast whenever the backend answers a
  // sudo prompt with a stored password, on any tab.
  useEffect(() => {
    const unlisten = onPtySudo((p) =>
      toast.info(`Auto-filled sudo password for ${p.host_label}`),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // The auto-filled password bounced (sudo said "Sorry, try again.") — warn so
  // the operator fixes the stored sudo password (D-065, 11.3). Auto-fill has
  // already stopped itself; the prompt is now the operator's to answer.
  useEffect(() => {
    const unlisten = onPtySudoRejected((p) =>
      toast.warning(
        `Possible wrong sudo password for ${p.host_label}. Auto-fill stopped; enter it manually`,
      ),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const openTerminal = useCallback((host: Host) => {
    const session: TermSession = {
      id: crypto.randomUUID(),
      type: "ssh",
      seq: nextSeq(),
      host,
    };
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
    setPage("terminals");
  }, [nextSeq]);

  /** Adopt a skill run's live shell as a terminal tab. The tab reuses the
   * backend session id as its own, so the very shell the skill was driving (its
   * root state, cwd and scrollback) carries over; TerminalView skips pty_open
   * for an adopted session. `snapshot` is the skill pane's scrollback as an ANSI
   * string, seeded into the new terminal so the run's history is visible. */
  const adoptTerminal = useCallback(
    (sessionId: string, host: Host, snapshot: string | null) => {
      const session: TermSession = {
        id: sessionId,
        type: "ssh",
        seq: nextSeq(),
        host,
        adopted: true,
        adoptSnapshot: snapshot ?? undefined,
      };
      setSessions((prev) =>
        prev.some((s) => s.id === sessionId) ? prev : [...prev, session],
      );
      setActiveSessionId(sessionId);
      setPage("terminals");
    },
    [nextSeq],
  );

  /** Open a terminal tab for every host at once (Hosts multi-select). */
  const openTerminals = useCallback((hostsToOpen: Host[]) => {
    if (hostsToOpen.length === 0) return;
    const newSessions: TermSession[] = hostsToOpen.map((host) => ({
      id: crypto.randomUUID(),
      type: "ssh" as const,
      seq: nextSeq(),
      host,
    }));
    setSessions((prev) => [...prev, ...newSessions]);
    setActiveSessionId(newSessions[0].id);
    setPage("terminals");
  }, [nextSeq]);

  /** Open a local shell (PowerShell / pwsh / Command Prompt / WSL) as a tab.
   * `opts` carries a saved profile's cwd / startup command / name when the open
   * came from a profile; absent for a plain shell pick. */
  const openLocalShell = useCallback(
    (shell: LocalShell, opts?: LocalShellOpenOpts) => {
      const session: TermSession = {
        id: crypto.randomUUID(),
        type: "local",
        seq: nextSeq(),
        shell,
        cwd: opts?.cwd,
        startupCommand: opts?.startupCommand,
        profileLabel: opts?.profileLabel,
      };
      setSessions((prev) => [...prev, session]);
      setActiveSessionId(session.id);
      setPage("terminals");
    },
    [nextSeq],
  );

  const handleConnectionChange = useCallback(
    (sessionId: string, connected: boolean) => {
      setConnectedSessions((prev) => {
        if (prev.has(sessionId) === connected) return prev;
        const next = new Set(prev);
        if (connected) {
          next.add(sessionId);
        } else {
          next.delete(sessionId);
        }
        return next;
      });
    },
    [],
  );

  /** Drag-to-reorder terminal tabs: move the dragged session so it lands in
   * front of the drop target, preserving every other tab's relative order. */
  const reorderSessions = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setSessions((prev) => {
      const from = prev.findIndex((s) => s.id === sourceId);
      const to = prev.findIndex((s) => s.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  const closeSession = useCallback((id: string) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const next = prev.filter((s) => s.id !== id);
      setActiveSessionId((current) => {
        if (current !== id) return current;
        if (next.length === 0) return null;
        return next[Math.min(idx, next.length - 1)].id;
      });
      return next;
    });
  }, []);

  /** Terminate every live terminal session for a host (from the Hosts tab).
   * Removing the sessions unmounts their TerminalViews, whose cleanup calls
   * ptyClose — the same teardown path as closing a tab. */
  const terminateHost = useCallback((hostId: number) => {
    setSessions((prev) => {
      const next = prev.filter(
        (s) => !(s.type === "ssh" && s.host.id === hostId),
      );
      if (next.length === prev.length) return prev;
      setActiveSessionId((current) => {
        if (current && !next.some((s) => s.id === current)) {
          return next.length ? next[next.length - 1].id : null;
        }
        return current;
      });
      return next;
    });
  }, []);

  /** Close every open terminal session at once. Clearing the list unmounts the
   * TerminalViews, whose cleanup calls ptyClose (same teardown as closing each
   * tab). Used by MultiTerminal's "Close all terminals" rail button. */
  const closeAllTerminals = useCallback(() => {
    setSessions((prev) => {
      if (prev.length === 0) return prev;
      setActiveSessionId(null);
      setMaxSessionId(null);
      return [];
    });
  }, []);

  /** Jump from a MultiTerminal block to that host's live terminal: switch to the
   * Terminals page and select the host's first open session. */
  const jumpToHostTerminal = useCallback(
    (hostId: number) => {
      const sess = sessions.find(
        (s) => s.type === "ssh" && s.host.id === hostId,
      );
      if (!sess) return;
      setActiveSessionId(sess.id);
      setMaxSessionId(null);
      setPage("terminals");
    },
    [sessions],
  );

  const openShortcutSettings = useCallback(() => {
    setSettingsFocus("shortcuts");
    setPage("settings");
  }, []);

  // Mount Settings the first time it's opened, then leave it mounted (below) so
  // re-visits are instant. We deliberately do NOT pre-warm at startup: mounting
  // this large tree is genuinely expensive, and doing it during launch (which
  // already mounts every other page) made the whole app hitch — worse on slow
  // machines. Instead we defer the mount two frames so the branded loader paints
  // first; its spinner is GPU-composited, so it keeps animating smoothly even
  // while the heavy first render blocks the main thread. One-time, per launch.
  useEffect(() => {
    if (page !== "settings" || settingsMounted) return;
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => setSettingsMounted(true));
    });
    return () => cancelAnimationFrame(outer);
  }, [page, settingsMounted]);

  const maximizeTerminal = useCallback((id: string) => {
    setActiveSessionId(id);
    setMaxSessionId(id);
  }, []);
  const restoreTerminal = useCallback(() => setMaxSessionId(null), []);

  // F11 toggles the maximized terminal — the standard fullscreen key, and
  // (unlike Esc) one the shell and TUI apps like vim/less never use, so it's
  // safe to capture. Capture phase fires before xterm consumes the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      e.stopPropagation();
      if (maximized) {
        setMaxSessionId(null);
      } else if (page === "terminals" && activeSessionId !== null) {
        setMaxSessionId(activeSessionId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [maximized, page, activeSessionId]);

  // Intercept the window close: if the guard is on and something is still
  // connected, hold the close and ask first. Registered once; reads the live
  // connection set / preference through refs and localStorage so it never goes
  // stale. Confirming sets closingRef and calls destroy(), which closes without
  // re-emitting the request (unlike close()).
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      if (closingRef.current) return;
      if (isExitGuardEnabled() && connectedRef.current.size > 0) {
        event.preventDefault();
        setExitConfirmOpen(true);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const confirmQuit = useCallback(() => {
    closingRef.current = true;
    setExitConfirmOpen(false);
    getCurrentWindow()
      .destroy()
      .catch(() => {
        // If destroy somehow fails, drop the latch so the guard still works.
        closingRef.current = false;
      });
  }, []);

  // Drop back to the tabbed view when the maximized terminal is gone (closed
  // or terminated) or we've left the Terminals page.
  useEffect(() => {
    if (
      maxSessionId !== null &&
      (page !== "terminals" || !sessions.some((s) => s.id === maxSessionId))
    ) {
      setMaxSessionId(null);
    }
  }, [maxSessionId, page, sessions]);

  const connectedHostIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of sessions) {
      if (s.type === "ssh" && connectedSessions.has(s.id)) ids.add(s.host.id);
    }
    return ids;
  }, [sessions, connectedSessions]);

  // Hosts with at least one open terminal tab (connected or not) — drives the
  // "already open" guard rails on the Hosts page (H7/H8). Local shells excluded.
  const openHostIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of sessions) if (s.type === "ssh") ids.add(s.host.id);
    return ids;
  }, [sessions]);

  // SSH-only sessions for MultiTerminal, whose aggregate block view needs the
  // OSC 133 markers only the SSH path emits. PTY Broadcast now takes the full
  // session list — its local-shell tabs fan out to open PowerShell/cmd/WSL too.
  const sshSessions = useMemo(
    () => sessions.filter((s): s is SshTermSession => s.type === "ssh"),
    [sessions],
  );

  const maximizedSession =
    sessions.find((s) => s.id === maxSessionId) ?? null;

  return (
    <StatusProvider>
      <UiPrefsProvider>
      <AppShell
        active={page}
        onNavigate={setPage}
        terminalCount={sessions.length}
        maximized={maximized}
        onRestore={restoreTerminal}
        maximizedHost={
          maximizedSession
            ? maximizedSession.type === "ssh"
              ? maximizedSession.host
              : { label: maximizedSession.shell.label, color: "#6b7280" }
            : null
        }
      >
      {page === "hosts" && (
        <HostsPage
          onOpenTerminal={openTerminal}
          onOpenTerminals={openTerminals}
          onTerminateHost={terminateHost}
          connectedHostIds={connectedHostIds}
          openHostIds={openHostIds}
        />
      )}
      {/* Broadcast stays mounted so output and host selection survive
          navigation (work-queue: "output history" persistence). */}
      <div className={page === "broadcast" ? "block h-full" : "hidden"}>
        <BroadcastPage
          visible={page === "broadcast"}
          connectedHostIds={connectedHostIds}
          onManageShortcuts={openShortcutSettings}
        />
      </div>
      {/* PTY Broadcast stays mounted so host selection and dispatch history
          survive tab switches (work queue 2026-06-13). */}
      <div className={page === "ptybroadcast" ? "block h-full" : "hidden"}>
        <PtyBroadcastPage
          visible={page === "ptybroadcast"}
          sessions={sessions}
          connectedSessions={connectedSessions}
          onManageShortcuts={openShortcutSettings}
        />
      </div>
      {/* Terminals stay mounted so sessions survive navigation. */}
      <div className={page === "terminals" ? "block h-full" : "hidden"}>
        <TerminalsPage
          sessions={sessions}
          activeId={activeSessionId}
          visible={page === "terminals"}
          connectedSessions={connectedSessions}
          onConnectionChange={handleConnectionChange}
          onActivate={setActiveSessionId}
          onCloseSession={closeSession}
          onReorder={reorderSessions}
          onMaximize={maximizeTerminal}
          maximized={maximized}
          onOpenLocalShell={openLocalShell}
          onManageShortcuts={openShortcutSettings}
        />
      </div>
      {/* MultiTerminal stays mounted so its aggregated block log survives tab
          switches (it subscribes to every session's pty:block stream). */}
      <div className={page === "multiterminal" ? "block h-full" : "hidden"}>
        <MultiTerminalPage
          visible={page === "multiterminal"}
          sessions={sshSessions}
          connectedSessions={connectedSessions}
          onManageShortcuts={openShortcutSettings}
          onCloseAllTerminals={closeAllTerminals}
          onJumpToHostTerminal={jumpToHostTerminal}
        />
      </div>
      {/* Skills stays mounted so a running skill — and its live per-host panes —
          survive tab switches. A run can last as long as an apt upgrade, and
          unmounting would tear down the xterm panes mid-run. */}
      <div className={page === "skills" ? "block h-full" : "hidden"}>
        <SkillsPage visible={page === "skills"} onAdoptTerminal={adoptTerminal} />
      </div>
      {/* SFTP stays mounted so an open browser session survives navigation. */}
      <div className={page === "sftp" ? "block h-full" : "hidden"}>
        <SftpPage visible={page === "sftp"} />
      </div>
      {/* Logs stay mounted so a loaded session survives navigation. */}
      <div className={page === "logs" ? "block h-full" : "hidden"}>
        <LogsPage visible={page === "logs"} />
      </div>
      {/* Settings stays mounted after first open so re-visits are instant; the
          hidden div keeps it out of view while another tab is active. */}
      {settingsMounted && (
        <div className={page === "settings" ? "block" : "hidden"}>
          <Suspense fallback={null}>
            <SettingsPage
              visible={page === "settings"}
              focusSection={settingsFocus}
              onFocusConsumed={() => setSettingsFocus(null)}
              onReady={handleSettingsReady}
            />
          </Suspense>
        </div>
      )}
      {/* Branded loader while Settings warms up (only seen if the tab is opened
          before the background pre-warm finishes). */}
      {page === "settings" && !settingsReady && <SettingsLoading />}
      {page === "help" && (
        <Suspense fallback={null}>
          <HelpPage />
        </Suspense>
      )}
        <UnlockDialog
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onUnlocked={() => {}}
        />
        <AlertDialog open={exitConfirmOpen} onOpenChange={setExitConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Quit with terminals connected?</AlertDialogTitle>
              <AlertDialogDescription>
                <span className="font-semibold text-foreground">
                  {connectedSessions.size}
                </span>{" "}
                terminal {connectedSessions.size === 1 ? "session is" : "sessions are"}{" "}
                still connected. Quitting now disconnects{" "}
                {connectedSessions.size === 1 ? "it" : "them"} and loses any
                unsaved work in those shells. You can turn this warning off in
                Settings, under Performance.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Stay open</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={confirmQuit}>
                Quit anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Toaster />
      </AppShell>
      </UiPrefsProvider>
    </StatusProvider>
  );
}

export default App;
