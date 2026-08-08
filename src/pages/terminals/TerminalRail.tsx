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
 * Grouping alone only held at a 16px app font, though, because the budget it
 * was measured against was in rem and the window minimum it had to fit is in
 * pixels. At 20px the same row wants a quarter more room than it did and the
 * Sessions button was clipped off the edge again. So the row now measures
 * itself (see lib/useRailCompact) and, when it will not fit, keeps the icons
 * and drops the words. Tabs | Grid is the exception: it is not a pair of
 * actions but a report of which mode is on, and two icons alone do not say
 * which of them is lit.
 *
 * What stays out of the menu is decided by how often it is used, not by what it
 * does. Fullscreen and Grid Titles are the two most-toggled controls in grid
 * mode, so they stay in the rail as icon-only buttons (~32px each against ~120px
 * with a label) rather than costing two clicks and a hunt. Grid Titles has no
 * shortcut at all, which is exactly why burying it would hurt. `useHint()`
 * narrates both in the status bar on hover, so dropping the text costs
 * discoverability nothing.
 *
 * Fullscreen means two different things in the two layouts, and both are
 * offered in both places (the icon and the View menu). In Grid it is the whole
 * wall filling the screen, Ctrl+Shift+G. In Tabs there is no wall, so it is the
 * one terminal you are looking at filling the window, F11, which existed all
 * along as a key and a per-tab button but was nowhere in the rail, so a Tabs
 * user had no way to find it.
 *
 * **A control that cannot act right now is greyed, not removed.** Fullscreen
 * with nothing to fill the screen with, Reset grid with nothing pinned, Reset
 * display with no active terminal: all three used to disappear, and a control
 * that is not on screen cannot be learned. Greyed says the two things the
 * operator needs at once, that the action exists and that it is waiting on
 * something, and it keeps the menu the same shape from one moment to the next
 * so a reader stops having to re-find every entry. The exception is the two-up
 * flip, which is not an unavailable action but a statement about an arrangement
 * that only exists at exactly two tiles; the entry itself is meaningless
 * elsewhere, so it goes.
 *
 * The Sessions menu's bulk repairs, **Retry all**, **Close failed** and
 * **Unhide all**, are the other exception, and they are worth naming because
 * they look at first like a breach of the rule rather than a limit on it. What
 * greying buys is a reader learning that an action exists before the day they
 * want it, and that is worth a permanently dead row when the action is the only
 * clue to something non-obvious: Reset grid greyed is how anyone finds out a
 * tile edge can be dragged at all. None of these three teaches anything. "Retry
 * all" and "Close failed" arrive already understood the moment a pane goes red,
 * and "Unhide all" the moment one is hidden, so carrying them through every
 * other moment buys nothing and costs length in the one menu that is already as
 * long as the session list.
 *
 * Each of the three says what it is waiting for, in the status bar, while it is
 * greyed, which takes a little work: the browser will not dispatch a mouse
 * event to a disabled button and the menu's own disabled style drops pointer
 * events, so the naive version silences exactly the hint that matters most.
 * The button hangs its hint on a wrapper span; the menu entries take their
 * pointer events back. See both below.
 */

import { useRef } from "react";
import {
  ChevronDownIcon,
  Columns2Icon,
  EyeIcon,
  EyeOffIcon,
  Grid2x2Icon,
  LayoutGridIcon,
  ListIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelTopIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Rows2Icon,
  SlidersHorizontalIcon,
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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShortcutBar } from "@/components/ShortcutBar";
import { useHint } from "@/lib/status";
import { useRailCompact } from "@/lib/useRailCompact";
import { useUiPrefs } from "@/lib/uiPrefs";
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
  maximizeActive,
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
  retryableCount,
  onRetryAll,
  onCloseFailed,
  hiddenCount,
  onUnhideAll,
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
  /** Fill the window with the active terminal (what F11 does). No-op with no
   * active session, which is why the control is hidden in that case. */
  maximizeActive: () => void;
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
  /** How many panes are sitting on a Try again / Reconnect button. One number
   * for both repairs: whatever Retry all would bring back is exactly what Close
   * failed would clear away, which is what makes the pair readable. */
  retryableCount: number;
  onRetryAll: () => void;
  onCloseFailed: () => void;
  /** How many open terminals are currently taken out of the grid. */
  hiddenCount: number;
  onUnhideAll: () => void;
}) {
  const hint = useHint();
  // The flip is only meaningful at exactly two tiles: one fills the area, three
  // or more tile and scroll. Two always take this layout whether or not a Grid
  // size is pinned, so customGrid is false here by construction.
  const showTwoUpFlip = gridMode && !customGrid && gridCount === 2;

  // Fullscreen, in whichever sense this layout has one, and the same question
  // asked of both: is there anything to fill the screen with? Tabs needs an
  // open terminal; Grid needs at least one tile in it, which is not the same as
  // a session existing, because a tab can be taken out of the grid and leave it
  // empty. It used to be `gridMode || activeId !== null`, which asked neither:
  // Grid answered yes with nothing in it and went fullscreen on an empty wall.
  //
  // Unavailable now greys the control out where it used to remove it. A control
  // that vanishes cannot be found again, and a reader who never sees it does
  // not learn it is there for when they do have a terminal open. Greyed says
  // both things at once: it exists, and not yet.
  const canFullscreen = gridMode ? gridCount > 0 : activeId !== null;
  const fullscreenKey = gridMode ? "Ctrl+Shift+G" : "F11";
  const toggleFullscreen = () => {
    if (gridMode) onGridFullscreen(!gridFullscreen);
    else maximizeActive();
  };
  const fullscreenHint = !canFullscreen
    ? gridMode
      ? "Nothing is in the grid to fill the screen with. Put a tab back in the grid first."
      : "No terminal is open to fill the window with. Open one first."
    : !gridMode
      ? "Fill the window with the active terminal (F11). F11 again brings the app back."
      : gridFullscreen
        ? "The grid fills the screen. Click, or press Ctrl+Shift+G, to come back."
        : "Fill the screen with the grid (Ctrl+Shift+G). The controls collapse to a tab at the top centre you hover or click to bring them back.";

  // What the Sessions menu is offering right now. Its two repair entries come
  // and go with the state of the sessions, so the hint that advertises the menu
  // has to as well: naming a way out that isn't in the list is worse than not
  // naming it at all.
  const sessionsExtras: string[] = [];
  if (retryableCount > 0) {
    sessionsExtras.push("retry or clear away the ones that dropped");
  }
  if (gridMode && hiddenCount > 0) {
    sessionsExtras.push("put hidden ones back in the grid");
  }
  const sessionsHint = `Jump to an open terminal session, ${sessionsExtras
    .map((e) => `${e}, `)
    .join("")}or close them all.`;

  // Out of room: the words go and the icons stay. The key is everything other
  // than the pane's width that changes how wide this row wants to be, so a
  // font change or a control appearing re-asks the question from scratch.
  const railRef = useRef<HTMLDivElement>(null);
  const { prefs } = useUiPrefs();
  const compact = useRailCompact(
    railRef,
    [
      prefs.appFontSize,
      canFullscreen,
      gridMode,
      showTwoUpFlip,
      sessions.length > 0,
    ].join("|"),
  );

  return (
    <div
      ref={railRef}
      className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5"
    >
      {/* Pane layout toggle: one tab at a time, or every open pane tiled at
          once like a skill run. A segmented switch rather than a single
          button so the current mode reads at a glance. */}
      <div
        role="group"
        aria-label="Terminal layout"
        // shrink-0 unlike the Buttons around it, which get it from
        // ui/button.tsx: these are plain <button>s, so without it the row
        // squeezes the two labels here before it touches the picker.
        className="flex shrink-0 items-center gap-0.5 rounded-md border border-input p-0.5"
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
        size={compact ? "icon-sm" : "sm"}
        variant={broadcastRail ? "secondary" : "outline"}
        onClick={toggleBroadcastRail}
        aria-pressed={broadcastRail}
        aria-label="Broadcast"
        {...hint(
          broadcastRail
            ? "Hide the broadcast rail."
            : "Show the broadcast rail: pick sessions and type one command for all of them, watching the panes as they answer.",
        )}
      >
        <RadioTowerIcon className="h-3.5 w-3.5" />
        {!compact && "Broadcast"}
      </Button>

      {/* Fullscreen. In Grid every tile fills the screen and all the chrome
          (this bar, the tab strip, the sidebar and status bar) collapses to a
          hover strip at the top; in Tabs the active terminal fills the window,
          the same thing F11 has always done. Icon-only: frequent enough to be
          worth its width, not worth a label. Never shows the collapse icon in
          Tabs, because a maximized terminal hides this bar along with the rest
          of the chrome, so it is only ever pressed on the way in. Always here,
          greyed when there is nothing to fill the screen with.

          The hint hangs on the wrapper, not on the button. A disabled button
          gets `pointer-events: none` from ui/button.tsx and the browser will
          not dispatch mouse events to a disabled control anyway, so a hint on
          the button itself would be exactly the one that never showed: the one
          saying why it is greyed. On the span it lands, because the span is not
          the disabled thing. This is the only icon-only control that can go
          dead, and an icon with no words and no explanation is a puzzle. */}
      <span className="flex shrink-0" {...hint(fullscreenHint)}>
        <Button
          size="icon-sm"
          variant={gridFullscreen ? "secondary" : "outline"}
          disabled={!canFullscreen}
          onClick={toggleFullscreen}
          aria-pressed={gridMode ? gridFullscreen : undefined}
          aria-label="Fullscreen"
        >
          {gridFullscreen ? (
            <Minimize2Icon className="h-3.5 w-3.5" />
          ) : (
            <Maximize2Icon className="h-3.5 w-3.5" />
          )}
        </Button>
      </span>

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
            size={compact ? "icon-sm" : "sm"}
            variant="outline"
            aria-label="View"
            {...hint(
              "Fullscreen, tab labels, tile arrangement and the two reset actions.",
            )}
          >
            <SlidersHorizontalIcon className="h-3.5 w-3.5" />
            {!compact && (
              <>
                View
                <ChevronDownIcon className="-mr-1 h-3.5 w-3.5 opacity-60" />
              </>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {/* Deliberately redundant with the icon beside it. The icon is for
              the operator who already knows what it is; the menu entry is how
              anyone else finds out that it exists and which key does it, which
              is the whole reason it is greyed rather than dropped when there is
              nothing to fill the screen with: an entry that is not there
              teaches nobody the key. */}
          <DropdownMenuItem
            disabled={!canFullscreen}
            // A greyed entry is the one most worth explaining, and the default
            // disabled style takes its pointer events away so it cannot raise
            // its hint. Radix already ignores pointer moves on a disabled item
            // (it clears the highlight rather than following the mouse), so
            // handing them back costs nothing and buys the status-bar line.
            className="data-disabled:pointer-events-auto"
            onSelect={toggleFullscreen}
            {...hint(fullscreenHint)}
          >
            {gridFullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
            {gridFullscreen ? "Leave fullscreen" : "Fullscreen"}
            <DropdownMenuShortcut>{fullscreenKey}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {/* Stated the positive way round, and on by default, because that is
              the state it is in until someone changes it: a box you have to
              untick to get what you already have reads backwards. The stored
              preference is still "compact", so nothing on disk moved. */}
          <DropdownMenuCheckboxItem
            checked={!tabsCompact}
            onCheckedChange={toggleTabsCompact}
            {...hint(
              tabsCompact
                ? "Tabs show the color dot + initials. Click for full labels."
                : "Tabs show the color dot + full label. Click for dot + initials.",
            )}
          >
            Full tab labels
          </DropdownMenuCheckboxItem>

          {/* The one entry that still comes and goes, and the exception proves
              the rule: everything else here is an action that exists and is
              momentarily unavailable, which is worth greying. This is not. At
              one tile or three there is no pair to arrange, and its label is a
              statement about the current arrangement ("Stack top / bottom"), so
              a greyed copy would be a sentence about a layout that is not on
              screen. */}
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

          <DropdownMenuSeparator />

          {/* The two recovery actions. Both are greyed rather than dropped when
              they have nothing to act on, for the same reason as Fullscreen
              above: this is where an operator comes to find out what the app
              can undo, and it can only tell them that if the entries are here
              when there is nothing wrong yet.

              Reset grid undoes a drag-resize (or a pinned size set in
              Settings) and goes back to fit-to-window. It is Grid's, so it is
              here only in Grid: in Tabs there is no grid on screen to reset and
              a greyed entry would be answering a question nobody asked. */}
          {gridMode && (
            <DropdownMenuItem
              disabled={!sizeIsPinned}
              className="data-disabled:pointer-events-auto"
              onSelect={resetTileSize}
              {...hint(
                sizeIsPinned
                  ? "Clear the tile size (dragged or set in Settings) and go back to original configured grid settings."
                  : "Nothing to reset: the tiles already fit the window. Drag a tile edge, or pin a size in Settings, and this clears it.",
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
          <DropdownMenuItem
            disabled={activeId === null}
            className="data-disabled:pointer-events-auto"
            onSelect={() => {
              if (activeId !== null) resetDisplay(activeId);
            }}
            {...hint(
              activeId === null
                ? "No terminal is active to redraw. Open one first."
                : "Redraw this pane from scratch if a program left it garbled. Clears its screen and scrollback; nothing running is interrupted.",
            )}
          >
            <RotateCcwIcon />
            Reset display
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <ShortcutBar
          shortcuts={shortcuts}
          activeScope={activeScope}
          disabled={activeId === null}
          compact={compact}
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
                aria-label="Sessions"
                {...hint(sessionsHint)}
              >
                {/* The count stays whatever happens: it is the live number of
                    open sessions, not decoration, and it is the reason someone
                    looks at this button without meaning to open it. */}
                {compact ? <ListIcon className="h-3.5 w-3.5" /> : "Sessions"}
                <span className="text-muted-foreground">
                  {sessions.length}
                </span>
                {!compact && (
                  <ChevronDownIcon className="-mr-1 h-3.5 w-3.5 opacity-60" />
                )}
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

              {/* The bulk repairs, above the bulk destruction. Each is the way
                  out of a state you can otherwise only leave one tab at a time,
                  which is the whole reason they are here: twenty panes that lost
                  their connection is twenty Try again buttons or twenty little
                  x's, and a grid you have emptied hides the very tabs whose eye
                  buttons would fill it again.

                  These are the exception to this file's greyed-not-removed
                  rule, and the exception is narrow: greying teaches an operator
                  that an action exists before they need it, which is worth a
                  dead row for something like Reset grid, where the action is
                  the only clue that tile edges can be dragged at all. These
                  three teach nothing you don't already know the moment they
                  appear, so a menu that stays short is worth more. */}
              {retryableCount > 0 && (
                <DropdownMenuItem
                  onSelect={onRetryAll}
                  {...hint(
                    retryableCount === 1
                      ? "Reconnect the one session that dropped or was refused. Sessions still connecting, and any waiting on a host-key answer, are left alone."
                      : `Reconnect all ${retryableCount} sessions that dropped or were refused, in one go. Sessions still connecting, and any waiting on a host-key answer, are left alone.`,
                  )}
                >
                  <RefreshCwIcon />
                  Retry all
                  <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">
                    {retryableCount}
                  </span>
                </DropdownMenuItem>
              )}

              {/* The other answer to the same tabs, and it shares Retry all's
                  count on purpose: the pane you would retry is the pane you
                  would give up on, so a reader who has understood one entry has
                  understood both. No confirmation, unlike Close all, because
                  every tab this touches is already dead, its shell already
                  gone; there is nothing here to interrupt or lose. */}
              {retryableCount > 0 && (
                <DropdownMenuItem
                  onSelect={onCloseFailed}
                  {...hint(
                    retryableCount === 1
                      ? "Close the one tab that dropped or was refused. Nothing is running in it, so nothing is interrupted."
                      : `Close all ${retryableCount} tabs that dropped or were refused, in one go. Nothing is running in them, so nothing is interrupted.`,
                  )}
                >
                  <XIcon />
                  Close failed
                  <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">
                    {retryableCount}
                  </span>
                </DropdownMenuItem>
              )}

              {/* Grid-only, like the per-tab eye button it undoes: in Tabs
                  every tab shows its own pane and nothing is hidden. */}
              {gridMode && hiddenCount > 0 && (
                <DropdownMenuItem
                  onSelect={onUnhideAll}
                  {...hint(
                    hiddenCount === 1
                      ? "Put the one hidden terminal back in the grid."
                      : `Put all ${hiddenCount} hidden terminals back in the grid at once.`,
                  )}
                >
                  <Grid2x2Icon />
                  Unhide all
                  <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">
                    {hiddenCount}
                  </span>
                </DropdownMenuItem>
              )}

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
