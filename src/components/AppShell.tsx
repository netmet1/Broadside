import { type ReactNode, useEffect, useState } from "react";
import {
  CastIcon,
  InfoIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RadioTowerIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  TerminalIcon,
} from "lucide-react";

import { AboutDialog } from "@/components/AboutDialog";
import { StatusBar } from "@/components/StatusBar";
import { useHint, useStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

export type Page =
  | "hosts"
  | "broadcast"
  | "ptybroadcast"
  | "terminals"
  | "logs"
  | "settings";

const NAV_ITEMS: {
  page: Page;
  label: string;
  icon: typeof ServerIcon;
  hint: string;
}[] = [
  {
    page: "hosts",
    label: "Hosts",
    icon: ServerIcon,
    hint: "Manage SSH connection targets and credentials",
  },
  {
    page: "broadcast",
    label: "Broadcast",
    icon: RadioTowerIcon,
    hint: "Send one command to many hosts at once",
  },
  {
    page: "ptybroadcast",
    label: "PTY Broadcast",
    icon: CastIcon,
    hint: "Type one command into every open terminal session",
  },
  {
    page: "terminals",
    label: "Terminals",
    icon: TerminalIcon,
    hint: "Interactive terminal sessions, one tab per host",
  },
  {
    page: "logs",
    label: "Logs",
    icon: ScrollTextIcon,
    hint: "Saved sessions, audit log and command history",
  },
  {
    page: "settings",
    label: "Settings",
    icon: SettingsIcon,
    hint: "Performance, guard rules and application options",
  },
];

/** Below this window width the sidebar auto-collapses to icons only. */
const COLLAPSE_BREAKPOINT = 1280;

const SIDEBAR_PREF_KEY = "sidebar-collapsed";

function loadManualPref(): boolean | null {
  switch (localStorage.getItem(SIDEBAR_PREF_KEY)) {
    case "true":
      return true;
    case "false":
      return false;
    default:
      return null;
  }
}

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
  const [aboutOpen, setAboutOpen] = useState(false);
  // null = no manual override; the width breakpoint decides.
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(
    loadManualPref,
  );
  const [narrow, setNarrow] = useState(
    () => window.innerWidth < COLLAPSE_BREAKPOINT,
  );
  const hint = useHint();
  const { clearHint } = useStatus();

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${COLLAPSE_BREAKPOINT - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setNarrow(e.matches);
      // Crossing the breakpoint hands control back to the automatic rule.
      setManualCollapsed(null);
      localStorage.removeItem(SIDEBAR_PREF_KEY);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // A hint can be left dangling when the hovered control disappears on click
  // (e.g. navigation swaps the page) — clear it on page change.
  useEffect(() => {
    clearHint();
  }, [active, clearHint]);

  const collapsed = manualCollapsed ?? narrow;

  const toggleSidebar = () => {
    const next = !collapsed;
    setManualCollapsed(next);
    localStorage.setItem(SIDEBAR_PREF_KEY, String(next));
  };

  return (
    <div className="dark flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
            collapsed ? "w-14" : "w-56",
          )}
        >
          <div
            className={cn(
              "flex h-14 shrink-0 items-center border-b border-sidebar-border",
              collapsed ? "justify-center" : "px-4",
            )}
          >
            {!collapsed && (
              <>
                <span className="font-heading text-base font-semibold tracking-tight">
                  OmniTerminal
                </span>
                <span className="ml-2 text-xs text-muted-foreground">v0.1a</span>
              </>
            )}
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              {...hint(
                collapsed
                  ? "Expand the navigation sidebar"
                  : "Collapse the navigation sidebar to icons",
              )}
              className={cn(
                "rounded-md p-1.5 text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                !collapsed && "ml-auto",
              )}
            >
              {collapsed ? (
                <PanelLeftOpenIcon className="h-4 w-4" />
              ) : (
                <PanelLeftCloseIcon className="h-4 w-4" />
              )}
            </button>
          </div>
          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {NAV_ITEMS.map(({ page, label, icon: Icon, hint: navHint }) => (
              <button
                key={page}
                type="button"
                onClick={() => onNavigate(page)}
                title={collapsed ? label : undefined}
                {...hint(navHint)}
                className={cn(
                  "relative flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                  collapsed && "justify-center px-0",
                  active === page
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && label}
                {page === "terminals" && terminalCount > 0 && (
                  <span
                    className={cn(
                      "rounded-full bg-sidebar-accent px-1.5 text-xs text-sidebar-accent-foreground",
                      collapsed ? "absolute -top-0.5 right-0.5" : "ml-auto",
                    )}
                  >
                    {terminalCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="shrink-0 p-2">
            <button
              type="button"
              onClick={() => setAboutOpen(true)}
              title={collapsed ? "About" : undefined}
              {...hint("Version, copyright and project information")}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              <InfoIcon className="h-4 w-4 shrink-0" />
              {!collapsed && "About"}
            </button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
      <StatusBar />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  );
}
