import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell, type Page } from "@/components/AppShell";
import { HostsPage } from "@/pages/HostsPage";
import { BroadcastPage } from "@/pages/BroadcastPage";
import { TerminalsPage, type TermSession } from "@/pages/TerminalsPage";
import { PtyBroadcastPage } from "@/pages/PtyBroadcastPage";
import { OmniTerminalPage } from "@/pages/OmniTerminalPage";
import { LogsPage } from "@/pages/LogsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { UnlockDialog } from "@/components/UnlockDialog";
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
  // Session ids with a live PTY connection (drives Hosts connected dots).
  const [connectedSessions, setConnectedSessions] = useState<Set<string>>(
    new Set(),
  );
  // Set when "Manage shortcuts…" is picked — Settings scrolls there on open.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  // Maximized terminal: the id of the session filling the whole window (null =
  // normal view). Tracking the id (not a bool) lets us drop back to the tabbed
  // view automatically when that specific terminal is closed.
  const [maxSessionId, setMaxSessionId] = useState<string | null>(null);
  const maximized = maxSessionId !== null;

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
        `Possible wrong sudo password for ${p.host_label} — auto-fill stopped; enter it manually`,
      ),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const openTerminal = useCallback((host: Host) => {
    const session: TermSession = { id: crypto.randomUUID(), host };
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
    setPage("terminals");
  }, []);

  /** Open a terminal tab for every host at once (Hosts multi-select). */
  const openTerminals = useCallback((hostsToOpen: Host[]) => {
    if (hostsToOpen.length === 0) return;
    const newSessions: TermSession[] = hostsToOpen.map((host) => ({
      id: crypto.randomUUID(),
      host,
    }));
    setSessions((prev) => [...prev, ...newSessions]);
    setActiveSessionId(newSessions[0].id);
    setPage("terminals");
  }, []);

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
      const next = prev.filter((s) => s.host.id !== hostId);
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

  const openShortcutSettings = useCallback(() => {
    setSettingsFocus("shortcuts");
    setPage("settings");
  }, []);

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
      if (connectedSessions.has(s.id)) ids.add(s.host.id);
    }
    return ids;
  }, [sessions, connectedSessions]);

  // Hosts with at least one open terminal tab (connected or not) — drives the
  // "already open" guard rails on the Hosts page (H7/H8).
  const openHostIds = useMemo(
    () => new Set(sessions.map((s) => s.host.id)),
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
        maximizedHost={maximizedSession?.host ?? null}
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
          onConnectionChange={handleConnectionChange}
          onActivate={setActiveSessionId}
          onCloseSession={closeSession}
          onReorder={reorderSessions}
          onMaximize={maximizeTerminal}
          maximized={maximized}
          onManageShortcuts={openShortcutSettings}
        />
      </div>
      {/* OmniTerminal stays mounted so its aggregated block log survives tab
          switches (it subscribes to every session's pty:block stream). */}
      <div className={page === "omniterminal" ? "block h-full" : "hidden"}>
        <OmniTerminalPage
          visible={page === "omniterminal"}
          sessions={sessions}
          connectedSessions={connectedSessions}
          onManageShortcuts={openShortcutSettings}
        />
      </div>
      {/* Logs stay mounted so a loaded session survives navigation. */}
      <div className={page === "logs" ? "block h-full" : "hidden"}>
        <LogsPage visible={page === "logs"} />
      </div>
      {page === "settings" && (
        <SettingsPage
          focusSection={settingsFocus}
          onFocusConsumed={() => setSettingsFocus(null)}
        />
      )}
        <UnlockDialog
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onUnlocked={() => {}}
        />
        <Toaster />
      </AppShell>
      </UiPrefsProvider>
    </StatusProvider>
  );
}

export default App;
