import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  CastIcon,
  CircleHelpIcon,
  FolderTreeIcon,
  InfoIcon,
  LayersIcon,
  Minimize2Icon,
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
import logoUrl from "@/assets/rail_image.png";
import { useHint, useStatus } from "@/lib/status";
import { useAppVersion } from "@/lib/useAppVersion";
import { cn } from "@/lib/utils";

export type Page =
  | "hosts"
  | "broadcast"
  | "ptybroadcast"
  | "terminals"
  | "multiterminal"
  | "sftp"
  | "logs"
  | "settings"
  | "help";

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
    page: "terminals",
    label: "Terminals",
    icon: TerminalIcon,
    hint: "Interactive terminal sessions, one tab per host",
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
    page: "multiterminal",
    label: "MultiTerminal",
    icon: LayersIcon,
    hint: "Run a command across all terminals and see every host's output, color-tinted (needs 2+ open)",
  },
  {
    page: "sftp",
    label: "SFTP",
    icon: FolderTreeIcon,
    hint: "Browse and transfer files over SFTP",
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
const SIDEBAR_WIDTH_KEY = "sidebar-width";

/** The full-label width (was the fixed `w-56`) — the maximum; can't grow past
 * it. The icon-only strip is `w-14`. Dragging narrower than the snap width
 * collapses to icons. */
const SIDEBAR_MAX_WIDTH = 224;
const SIDEBAR_ICON_WIDTH = 56;
const SIDEBAR_COLLAPSE_SNAP = 120;

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

function loadWidth(): number {
  const n = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (!Number.isFinite(n) || n <= 0) return SIDEBAR_MAX_WIDTH;
  return Math.min(Math.max(n, SIDEBAR_COLLAPSE_SNAP), SIDEBAR_MAX_WIDTH);
}

export function AppShell({
  active,
  onNavigate,
  terminalCount,
  maximized = false,
  onRestore,
  maximizedHost = null,
  children,
}: {
  active: Page;
  onNavigate: (page: Page) => void;
  terminalCount: number;
  /** When true, hide all chrome and show only the maximized terminal. */
  maximized?: boolean;
  /** Restore from the maximized terminal (banner button + Esc). */
  onRestore?: () => void;
  /** The maximized terminal's host, shown in the banner so you know which
   * session is filling the window. */
  maximizedHost?: { label: string; color: string } | null;
  children: ReactNode;
}) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const version = useAppVersion();
  // null = no manual override; the width breakpoint decides.
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(
    loadManualPref,
  );
  const [narrow, setNarrow] = useState(
    () => window.innerWidth < COLLAPSE_BREAKPOINT,
  );
  // Drag-resizable expanded width (px). The icon-only width is fixed.
  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
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

  const setCollapsed = (next: boolean) => {
    setManualCollapsed(next);
    localStorage.setItem(SIDEBAR_PREF_KEY, String(next));
  };

  const toggleSidebar = () => setCollapsed(!collapsed);

  // Drag the separator to resize. Narrower than the snap width collapses to
  // icons; the coded max width can't be exceeded.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const left = asideRef.current?.getBoundingClientRect().left ?? 0;
      const raw = e.clientX - left;
      if (raw < SIDEBAR_COLLAPSE_SNAP) {
        if (!collapsed) setCollapsed(true);
        return; // keep the stored expanded width for when it's re-expanded
      }
      const next = Math.min(raw, SIDEBAR_MAX_WIDTH);
      if (collapsed) setCollapsed(false);
      setWidth(next);
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Suppress text selection / iframe focus stealing while dragging.
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [dragging, collapsed]);

  // Maximized terminal: keep the SAME tree (so the terminal's TerminalView is
  // never remounted — that would kill and reopen the PTY) but hide the sidebar,
  // separator and status bar via CSS and show a slim banner above the terminal.
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {maximized && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground">
          <span className="font-heading text-sm font-semibold tracking-tight">
            Broadside
          </span>
          {version && (
            <span className="text-xs text-muted-foreground">v{version}</span>
          )}
          {maximizedHost && (
            <span className="ml-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: maximizedHost.color }}
              />
              <span className="truncate">{maximizedHost.label}</span>
            </span>
          )}
          <button
            type="button"
            onClick={onRestore}
            aria-label="Restore terminal"
            title="Restore terminal (F11)"
            className="ml-auto rounded-md p-1 text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
          >
            <Minimize2Icon className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside
          ref={asideRef}
          style={{ width: collapsed ? SIDEBAR_ICON_WIDTH : width }}
          className={cn(
            "flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
            !dragging && "transition-[width] duration-150",
            maximized && "hidden",
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
                <span className="truncate font-heading text-base font-semibold tracking-tight">
                  Broadside
                </span>
                {version && (
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                    v{version}
                  </span>
                )}
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
                  "relative flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-sm font-medium",
                  collapsed && "justify-center px-0",
                  active === page
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{label}</span>}
                {page === "terminals" && terminalCount > 0 && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full bg-sidebar-accent px-1.5 text-xs text-sidebar-accent-foreground",
                      collapsed ? "absolute -top-0.5 right-0.5" : "ml-auto",
                    )}
                  >
                    {terminalCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="shrink-0 space-y-1 p-2">
            {!collapsed && width >= SIDEBAR_MAX_WIDTH && (
              <div
                aria-hidden
                className="pointer-events-none mb-2 h-24 overflow-hidden rounded-md opacity-[0.85]"
                style={{
                  maskImage:
                    "linear-gradient(to bottom, transparent, #000 50%, #000 88%, transparent)",
                  WebkitMaskImage:
                    "linear-gradient(to bottom, transparent, #000 50%, #000 88%, transparent)",
                }}
              >
                <img
                  src={logoUrl}
                  alt=""
                  draggable={false}
                  className="h-full w-full select-none object-cover grayscale opacity-30"
                  style={{ objectPosition: "center 42%" }}
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => onNavigate("help")}
              title={collapsed ? "Help" : undefined}
              {...hint("Guided documentation for every tab and feature")}
              className={cn(
                "flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-sm font-medium",
                collapsed && "justify-center px-0",
                active === "help"
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              )}
            >
              <CircleHelpIcon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">Help</span>}
            </button>
            <button
              type="button"
              onClick={() => setAboutOpen(true)}
              title={collapsed ? "About" : undefined}
              {...hint("Version, copyright and project information")}
              className={cn(
                "flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                collapsed && "justify-center px-0",
              )}
            >
              <InfoIcon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">About</span>}
            </button>
          </div>
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDoubleClick={() => {
            // Double-click resets to the full width (and un-collapses).
            setCollapsed(false);
            setWidth(SIDEBAR_MAX_WIDTH);
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_MAX_WIDTH));
          }}
          title="Drag to resize · double-click to reset"
          className={cn(
            "w-1 shrink-0 cursor-col-resize hover:bg-primary/40",
            dragging && "bg-primary/50",
            maximized && "hidden",
          )}
        />
        <main className="relative min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
      {!maximized && <StatusBar />}
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  );
}
