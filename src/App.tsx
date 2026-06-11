import { useEffect, useState } from "react";

import { AppShell, type Page } from "@/components/AppShell";
import { HostsPage } from "@/pages/HostsPage";
import { BroadcastPage } from "@/pages/BroadcastPage";
import { UnlockDialog } from "@/components/UnlockDialog";
import { Toaster } from "@/components/ui/sonner";
import {
  isCredentialsUnlocked,
  requiresMasterPassword,
} from "@/lib/tauri/hosts";

function App() {
  const [page, setPage] = useState<Page>("hosts");
  const [unlockOpen, setUnlockOpen] = useState(false);

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

  return (
    <AppShell active={page} onNavigate={setPage}>
      {page === "hosts" ? <HostsPage /> : <BroadcastPage />}
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
