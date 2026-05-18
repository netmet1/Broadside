import { type ReactNode } from "react";
import { ServerIcon } from "lucide-react";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        <aside className="w-56 shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <div className="flex h-14 items-center border-b border-sidebar-border px-4">
            <span className="font-heading text-base font-semibold tracking-tight">
              OmniTerminal
            </span>
            <span className="ml-2 text-xs text-muted-foreground">v0.1a</span>
          </div>
          <nav className="p-2">
            <a
              href="#hosts"
              className="flex items-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 text-sm font-medium text-sidebar-accent-foreground"
            >
              <ServerIcon className="h-4 w-4" />
              Hosts
            </a>
          </nav>
        </aside>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
