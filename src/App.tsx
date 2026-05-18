import { AppShell } from "@/components/AppShell";
import { HostsPage } from "@/pages/HostsPage";
import { Toaster } from "@/components/ui/sonner";

function App() {
  return (
    <AppShell>
      <HostsPage />
      <Toaster />
    </AppShell>
  );
}

export default App;
