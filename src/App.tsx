import { useCallback, useEffect, useState } from "react";

import { AppShell, type Page } from "@/components/AppShell";
import { HostsPage } from "@/pages/HostsPage";
import { BroadcastPage } from "@/pages/BroadcastPage";
import { TerminalsPage, type TermSession } from "@/pages/TerminalsPage";
import { UnlockDialog } from "@/components/UnlockDialog";
import { Toaster } from "@/components/ui/sonner";
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

  return (
    <AppShell
      active={page}
      onNavigate={setPage}
      terminalCount={sessions.length}
    >
      {page === "hosts" && <HostsPage onOpenTerminal={openTerminal} />}
      {page === "broadcast" && <BroadcastPage />}
      {/* Terminals stay mounted so sessions survive navigation. */}
      <div className={page === "terminals" ? "block h-full" : "hidden"}>
        <TerminalsPage
          sessions={sessions}
          activeId={activeSessionId}
          visible={page === "terminals"}
          onActivate={setActiveSessionId}
          onCloseSession={closeSession}
        />
      </div>
      <UnlockDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        onUnlocked={() => {}}
      />
      <Toaster />
    </AppShell>
  );
}

export default App;
