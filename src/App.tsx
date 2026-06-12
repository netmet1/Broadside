import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell, type Page } from "@/components/AppShell";
import { HostsPage } from "@/pages/HostsPage";
import { BroadcastPage } from "@/pages/BroadcastPage";
import { TerminalsPage, type TermSession } from "@/pages/TerminalsPage";
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

  const openTerminal = useCallback((host: Host) => {
    const session: TermSession = { id: crypto.randomUUID(), host };
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
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

  const openShortcutSettings = useCallback(() => {
    setSettingsFocus("shortcuts");
    setPage("settings");
  }, []);

  const connectedHostIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of sessions) {
      if (connectedSessions.has(s.id)) ids.add(s.host.id);
    }
    return ids;
  }, [sessions, connectedSessions]);

  return (
    <StatusProvider>
      <UiPrefsProvider>
      <AppShell
        active={page}
        onNavigate={setPage}
        terminalCount={sessions.length}
      >
      {page === "hosts" && (
        <HostsPage
          onOpenTerminal={openTerminal}
          connectedHostIds={connectedHostIds}
        />
      )}
      {/* Broadcast stays mounted so output and host selection survive
          navigation (work-queue: "output history" persistence). */}
      <div className={page === "broadcast" ? "block h-full" : "hidden"}>
        <BroadcastPage
          visible={page === "broadcast"}
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
