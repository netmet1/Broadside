/**
 * The Terminals tab's controls line.
 *
 * Split out of `TerminalsPage` (which was over two thousand lines) and, more to
 * the point, regrouped. Eleven controls sat here in one non-wrapping flex row,
 * and nothing in it could shrink: `ui/button.tsx` hard-codes `shrink-0
 * whitespace-nowrap`, so at the app's own 1024px minimum window the row simply
 * ran off the edge into AppShell's horizontal scrollbar and the right-hand
 * group went with it.
 *
 * The fix is grouping rather than wrapping. A second row would cost vertical
 * space, which is the scarcer axis at a 700px minimum height, and a rail that
 * changes height reflows the terminal grid underneath it every time a
 * conditional button appears.
 *
 * What stays out of the menu is decided by how often it is used, not by what it
 * does. Fullscreen and Grid Titles are the two most-toggled controls in grid
 * mode, so they stay in the rail as icon-only buttons (~32px each against ~120px
 * with a label) rather than costing two clicks and a hunt. Fullscreen at least
 * has Ctrl+Shift+G; Grid Titles has no shortcut at all, which is exactly why
 * burying it would hurt. `useHint()` narrates both in the status bar on hover,
 * so dropping the text costs discoverability nothing.
 */

import {
  ChevronDownIcon,
  Columns2Icon,
  EyeIcon,
  EyeOffIcon,
  LayoutGridIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelTopIcon,
  RadioTowerIcon,
  RotateCcwIcon,
  Rows2Icon,
  SlidersHorizontalIcon,
  TextIcon,
  UndoIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShortcutBar } from "@/components/ShortcutBar";
import { useHint } from "@/lib/status";
import type { ShortcutScope } from "@/lib/tauri/settings";
import type { ScopedShortcut } from "@/lib/useShortcuts";
import { cn } from "@/lib/utils";
import { LocalShellIcon } from "@/pages/terminals/LocalShellIcon";
import { sessionLabel, type TermSession } from "@/pages/terminals/session";

export function TerminalRail({
  tabsCompact,
  toggleTabsCompact,
  layout,
  chooseLayout,
  broadcastRail,
  toggleBroadcastRail,
  gridMode,
  sizeIsPinned,
  resetTileSize,
  gridFullscreen,
  onGridFullscreen,
  hideGridHeaders,
  toggleGridHeaders,
  customGrid,
  gridCount,
  twoUpSplit,
  toggleTwoUpSplit,
  activeId,
  resetDisplay,
  shortcuts,
  activeScope,
  runShortcut,
  onManageShortcuts,
  sessions,
  tabSuffix,
  onActivate,
  onCloseAll,
}: {
  tabsCompact: boolean;
  toggleTabsCompact: () => void;
  layout: "tabs" | "grid";
  chooseLayout: (l: "tabs" | "grid") => void;
  broadcastRail: boolean;
  toggleBroadcastRail: () => void;
  gridMode: boolean;
  sizeIsPinned: boolean;
  resetTileSize: () => void;
  gridFullscreen: boolean;
  onGridFullscreen: (on: boolean) => void;
  hideGridHeaders: boolean;
  toggleGridHeaders: () => void;
  customGrid: boolean;
  gridCount: number;
  twoUpSplit: "cols" | "rows";
  toggleTwoUpSplit: () => void;
  activeId: string | null;
  resetDisplay: (id: string) => void;
  shortcuts: ScopedShortcut[];
  activeScope: ShortcutScope | null;
  runShortcut: (command: string) => void;
  onManageShortcuts: () => void;
  sessions: TermSession[];
  tabSuffix: Map<string, string>;
  onActivate: (id: string) => void;
  onCloseAll: () => void;
}) {
  const hint = useHint();
  // The flip is only meaningful at exactly two tiles: one fills the area, three
  // or more tile and scroll. Two always take this layout whether or not a Grid
  // size is pinned, so customGrid is false here by construction.
  const showTwoUpFlip = gridMode && !customGrid && gridCount === 2;

  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
      {/* Pane layout toggle: one tab at a time, or every open pane tiled at
          once like a skill run. A segmented switch rather than a single
          button so the current mode reads at a glance. */}
      <div
        role="group"
        aria-label="Terminal layout"
        className="flex items-center gap-0.5 rounded-md border border-input p-0.5"
      >
        <button
          type="button"
          onClick={() => chooseLayout("tabs")}
          aria-pressed={layout === "tabs"}
          className={cn(
            "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
            layout === "tabs"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          {...hint("One terminal at a time, picked with the tabs below.")}
        >
          <PanelTopIcon className="h-3.5 w-3.5" />
          Tabs
        </button>
        <button
          type="button"
          onClick={() => chooseLayout("grid")}
          aria-pressed={layout === "grid"}
          className={cn(
            "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
            layout === "grid"
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          {...hint("Every open terminal tiled at once, like a skill run.")}
        >
          <LayoutGridIcon className="h-3.5 w-3.5" />
          Grid
        </button>
      </div>

      {/* Broadcast a command to several open sessions without leaving the
          page, so the panes you are watching are the ones that answer.
          Available in both layouts; Grid is what it is really for. */}
      <Button
        size="sm"
        variant={broadcastRail ? "secondary" : "outline"}
        onClick={toggleBroadcastRail}
        aria-pressed={broadcastRail}
        {...hint(
          broadcastRail
            ? "Hide the broadcast rail."
            : "Show the broadcast rail: pick sessions and type one command for all of them, watching the panes as they answer.",
        )}
      >
        <RadioTowerIcon className="h-3.5 w-3.5" />
        Broadcast
      </Button>

      {/* Take the grid fullscreen: every tile fills the screen and all the
          chrome (this bar, the tab strip, the sidebar and status bar)
          collapses to a hover strip at the top. Grid-only, and icon-only:
          frequent enough to be worth its width, not worth a label. */}
      {gridMode && (
        <Button
          size="icon-sm"
          variant={gridFullscreen ? "secondary" : "outline"}
          onClick={() => onGridFullscreen(!gridFullscreen)}
          aria-pressed={gridFullscreen}
          aria-label="Grid fullscreen"
          {...hint(
            gridFullscreen
              ? "The grid fills the screen. Click (or press Ctrl+Shift+G, or Esc) to come back."
              : "Fill the screen with the grid (Ctrl+Shift+G). The controls collapse to a strip you hover to reveal, or reach with Ctrl+Shift+T.",
          )}
        >
          {gridFullscreen ? (
            <Minimize2Icon className="h-3.5 w-3.5" />
          ) : (
            <Maximize2Icon className="h-3.5 w-3.5" />
          )}
        </Button>
      )}

      {/* Hide/show every grid tile's title bar. Grid-only; the choice persists
          across restarts. Icon-only for the same reason as Fullscreen, and it
          is the one with no keyboard shortcut to fall back on. */}
      {gridMode && (
        <Button
          size="icon-sm"
          variant={hideGridHeaders ? "secondary" : "outline"}
          onClick={toggleGridHeaders}
          aria-pressed={hideGridHeaders}
          aria-label="Grid titles"
          {...hint(
            hideGridHeaders
              ? "Tile grid title bars are hidden. Click to show them."
              : "Tile grid title bars are shown. Click to hide them for a denser grid.",
          )}
        >
          {hideGridHeaders ? (
            <EyeOffIcon className="h-3.5 w-3.5" />
          ) : (
            <EyeIcon className="h-3.5 w-3.5" />
          )}
        </Button>
      )}

      {/* Everything else that shapes the view. All of it is occasional, and
          together it is what used to push this rail off a 1024px window. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            {...hint("Tab labels, tile arrangement, and the two reset actions.")}
          >
            <SlidersHorizontalIcon className="h-3.5 w-3.5" />
            View
            <ChevronDownIcon className="-mr-1 h-3.5 w-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem
            checked={tabsCompact}
            onCheckedChange={toggleTabsCompact}
            {...hint(
              tabsCompact
                ? "Tabs show the color dot + initials. Click for full labels."
                : "Tabs show the color dot + full label. Click for dot + initials.",
            )}
          >
            <TextIcon />
            Compact tab labels
          </DropdownMenuCheckboxItem>

          {showTwoUpFlip && (
            <DropdownMenuItem
              onSelect={toggleTwoUpSplit}
              {...hint(
                twoUpSplit === "cols"
                  ? "Terminals are side by side. Click to stack them top and bottom."
                  : "Terminals are stacked top and bottom. Click to place them side by side.",
              )}
            >
              {twoUpSplit === "cols" ? <Columns2Icon /> : <Rows2Icon />}
              {twoUpSplit === "cols"
                ? "Stack top / bottom"
                : "Place side by side"}
            </DropdownMenuItem>
          )}

          {(gridMode && sizeIsPinned) || activeId !== null ? (
            <DropdownMenuSeparator />
          ) : null}

          {/* Undo a drag-resize (or a pinned size set in Settings) and go back
              to fit-to-window. Only offered when a size is actually pinned, so
              it isn't a permanently dead entry. */}
          {gridMode && sizeIsPinned && (
            <DropdownMenuItem
              onSelect={resetTileSize}
              {...hint(
                "Clear the tile size (dragged or set in Settings) and go back to original configured grid settings.",
              )}
            >
              <UndoIcon />
              Reset grid
            </DropdownMenuItem>
          )}

          {/* Recovery for a pane a full-screen program left in a mess: an
              upgrade's restart dialog, a monitor that took the alternate
              screen, or a prompt nothing was reading, which echoes the arrow
              keys you pressed at it as ^[[A across the box it drew. Clears this
              pane's view only; the session and everything in it carry on. */}
          {activeId !== null && (
            <DropdownMenuItem
              onSelect={() => resetDisplay(activeId)}
              {...hint(
                "Redraw this terminal from scratch if a full-screen program left it garbled or stuck. Clears this pane's screen and scrollback, then asks the shell to redraw its prompt (Ctrl-L). Nothing is run and nothing is interrupted: anything working in this session keeps going.",
              )}
            >
              <RotateCcwIcon />
              Reset display
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <ShortcutBar
          shortcuts={shortcuts}
          activeScope={activeScope}
          disabled={activeId === null}
          onRun={runShortcut}
          onManage={onManageShortcuts}
        />
        {/* The jump list and Close all are one menu. Both are about the set of
            open sessions, and a Select that was really a command menu plus a
            button beside it was two controls saying one thing. */}
        {sessions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                {...hint("Jump to an open terminal session, or close them all.")}
              >
                Sessions
                <span className="text-muted-foreground">
                  {sessions.length}
                </span>
                <ChevronDownIcon className="-mr-1 h-3.5 w-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              {sessions.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() => onActivate(s.id)}
                  className={cn(s.id === activeId && "bg-accent/50")}
                >
                  {s.type === "ssh" ? (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: s.host.color }}
                    />
                  ) : (
                    <LocalShellIcon
                      kind={s.shell.kind}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                  )}
                  <span className="truncate">
                    {sessionLabel(s)}
                    {tabSuffix.get(s.id)}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onCloseAll}
                {...hint(
                  "Close every open terminal session at once (asks first)",
                )}
              >
                <XIcon />
                Close all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
