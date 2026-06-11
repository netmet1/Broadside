import { type ReactNode } from "react";
import { RadioTowerIcon, ServerIcon, TerminalIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type Page = "hosts" | "broadcast" | "terminals";

const NAV_ITEMS: { page: Page; label: string; icon: typeof ServerIcon }[] = [
  { page: "hosts", label: "Hosts", icon: ServerIcon },
  { page: "broadcast", label: "Broadcast", icon: RadioTowerIcon },
  { page: "terminals", label: "Terminals", icon: TerminalIcon },
];

export function AppShell({
  active,
  onNavigate,
  terminalCount,
  children,
}: {
  active: Page;
  onNavigate: (page: Page) => void;
  terminalCount: number;
  children: ReactNode;
}) {
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
          <nav className="space-y-1 p-2">
            {NAV_ITEMS.map(({ page, label, icon: Icon }) => (
              <button
                key={page}
                type="button"
                onClick={() => onNavigate(page)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                  active === page
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
                {page === "terminals" && terminalCount > 0 && (
                  <span className="ml-auto rounded-full bg-sidebar-accent px-1.5 text-xs text-sidebar-accent-foreground">
                    {terminalCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </aside>
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
