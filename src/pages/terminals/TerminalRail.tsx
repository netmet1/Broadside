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
 * The Sessions menu's bulk repairs, **Reconnect all**, **Close failed** and
 * **Unhide all**, are the other exception, and they are worth naming because
 * they look at first like a breach of the rule rather than a limit on it. What
 * greying buys is a reader learning that an action exists before the day they
 * want it, and that is worth a permanently dead row when the action is the only
 * clue to something non-obvious: Reset grid greyed is how anyone finds out a
 * tile edge can be dragged at all. None of these three teaches anything.
 * "Reconnect all" and "Close failed" arrive already understood the moment a
 * pane goes red, and "Unhide all" the moment one is hidden, so carrying them
 * through every other moment buys nothing and costs length in the one menu that
 * is already as long as the session list.
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
  UnplugIcon,
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
import {
  sessionColor,
  sessionLabel,
  type TermSession,
} from "@/pages/terminals/session";
import { isTintable } from "@/lib/terminalColors";
import { useShellColors } from "@/lib/useShellColors";

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
  openIds,
  onEndSession,
  onDisconnectAll,
  onCloseAll,
  retryableCount,
  onReconnectAll,
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
  /** Which sessions have a live shell behind them. Everything else in the list
   * is connecting, waiting on a host-key answer, or already gone. */
  openIds: Set<string>;
  /** End a session's shell and leave its tab where it is. */
  onEndSession: (id: string) => void;
  /** End every live shell at once and leave all the tabs where they are: the
   * bulk form of the per-row unplug button above. */
  onDisconnectAll: () => void;
  onCloseAll: () => void;
  /** How many panes are sitting on a Try again / Reconnect button. One number
   * for both repairs: whatever Reconnect all would bring back is exactly what
   * Close failed would clear away, which is what makes the pair readable. */
  retryableCount: number;
  onReconnectAll: () => void;
  onCloseFailed: () => void;
  /** How many open terminals are currently taken out of the grid. */
  hiddenCount: number;
  onUnhideAll: () => void;
}) {
  const hint = useHint();
  const shellColors = useShellColors();
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
    sessionsExtras.push("reconnect or clear away the ones that dropped");
  }
  if (openIds.size >= 2) {
    sessionsExtras.push("disconnect them all but keep the tabs");
  }
  if (gridMode && hiddenCount > 0) {
    sessionsExtras.push("put hidden ones back in the grid");
  }
  const sessionsHint = `Jump to an open terminal session, end one without closing its tab, ${sessionsExtras
    .map((e) => `${e}, `)
    .join("")}or close them all.`;

  // Out of room: the words go and the icons stay. The key is everything other
  // than the pane's width that changes how wide this row wants to be, so a
  // font change or a control appearing re-asks the question from scratch.
  const railRef = useRef<HTMLDivElement>(null);
  // Whether the Sessions menu is closing because a session was chosen from it,
  // as opposed to being dismissed. Read once by `onCloseAutoFocus` below, which
  // is the only thing that needs to tell those two apart.
  const pickedSession = useRef(false);
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
          Available in both layouts; Grid is what it is really for.

          Greyed below two sessions rather than removed, which is this file's
          rule for a control that will be wanted later: broadcasting to one
          terminal is just typing in it, and the rail costs a column of the
          window to say so. A reader who has never had two tabs open still sees
          the button and learns it is there, which they would not if it appeared
          from nowhere on the day they opened a second one. */}
      <Button
        size={compact ? "icon-sm" : "sm"}
        variant={broadcastRail ? "secondary" : "outline"}
        onClick={toggleBroadcastRail}
        disabled={sessions.length < 2}
        aria-pressed={broadcastRail}
        aria-label="Broadcast"
        {...hint(
          sessions.length < 2
            ? "Broadcast sends one command to several sessions at once. Open a second terminal and it turns on."
            : broadcastRail
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
          together it is what used to push this rail off a 1024px window.

          Non-modal for the same reason as the Sessions menu below, and mostly
          so the two behave alike: two menus side by side in one rail that
          answer an outside click differently is the kind of difference nobody
          can name and everybody feels. */}
      <DropdownMenu modal={false}>
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
            button beside it was two controls saying one thing.

            Not modal, which is the default and was wrong here. A modal menu
            puts `pointer-events: none` on the whole body for as long as it is
            open, so the first click anywhere outside is spent dismissing it and
            never reaches what was clicked; the terminal you were aiming at
            needs a second click. That is a fair trade for a menu you are
            expected to leave the moment you pick something, and a bad one for
            this menu, which stays open on purpose after the unplug button so
            you can end several sessions in a row. The cost of staying open
            should not be a wasted click on the way out. Non-modal also drops
            the focus trap and the scroll lock, neither of which this list
            wants. */}
        {sessions.length > 0 && (
          <DropdownMenu modal={false}>
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
            <DropdownMenuContent
              align="end"
              className="max-w-72"
              // Picking a session hands the keyboard to that session's
              // terminal, and Radix's own closing behaviour is to put it back
              // on this button. Whichever of the two runs last wins, and the
              // order is not ours to decide: `activateDeliberately` waits a
              // frame for the menu to go before it focuses anything, while
              // Radix restores focus from its own teardown. When Radix went
              // second the keyboard sat on this button while the ring was on a
              // tile, and typing went nowhere until the tile was clicked.
              //
              // So do not race it: when the close came from choosing a
              // session, say plainly that focus is already spoken for. Only
              // then, because dismissing the menu with Escape or a click
              // outside has chosen nothing, and returning the keyboard to the
              // button it came from is exactly right there.
              onCloseAutoFocus={(e) => {
                if (!pickedSession.current) return;
                pickedSession.current = false;
                e.preventDefault();
              }}
            >
              {sessions.map((s) => {
                // Same colour the tab wears, for the same reason: this list is
                // how you find a session when there are too many tabs to read,
                // and a column of identical grey icons is no help at all.
                const color = sessionColor(s, shellColors);
                return (
                <DropdownMenuItem
                  key={s.id}
                  onSelect={() => {
                    pickedSession.current = true;
                    onActivate(s.id);
                  }}
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
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        !isTintable(color) && "text-muted-foreground",
                      )}
                      style={isTintable(color) ? { color } : undefined}
                    />
                  )}
                  <span className="truncate">
                    {sessionLabel(s)}
                    {tabSuffix.get(s.id)}
                  </span>
                  {/* End the session, keep the tab.

                      Here rather than on the tab itself because the tab already
                      has an x, and two buttons a few pixels apart that both look
                      like "get rid of this" is how you close the wrong thing.
                      The distance is the point: this is the deliberate one, and
                      it is worth a menu.

                      Greyed rather than removed once the shell is gone, per this
                      file's rule, so the row keeps its shape and the column of
                      icons does not shuffle as sessions die.

                      All three pointer events are stopped, or the row
                      underneath takes them as "go to this session" and the menu
                      closes on the way to somewhere nobody asked to be.

                      Pointer-UP is the one that is easy to miss, and stopping
                      only the other two is worse than stopping none: the menu
                      item watches pointerdown to know the press started on
                      itself, and on pointerup it *synthesises a click* on the
                      row whenever it did not see one, so that a press which
                      began elsewhere and finished here still selects. Swallow
                      the pointerdown alone and that flag never gets set, so the
                      row manufactures the very click this button is trying not
                      to make: smoke 54 B7 (the unplug jumped you to the session
                      you had just ended) and B3 (and closed the menu doing it)
                      were both this, one event apart. */}
                  <button
                    type="button"
                    disabled={!openIds.has(s.id)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onPointerUp={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onEndSession(s.id);
                    }}
                    className={cn(
                      "ml-auto shrink-0 rounded-sm p-1 text-muted-foreground",
                      "hover:bg-destructive/10 hover:text-destructive",
                      "disabled:pointer-events-none disabled:opacity-30",
                    )}
                    {...hint(
                      openIds.has(s.id)
                        ? `End the shell on "${sessionLabel(s)}" and keep the tab. Everything it printed stays on screen, and the pane offers Reconnect when you want it back.`
                        : "Nothing to end: this session has no shell running. It is connecting, waiting on a host-key answer, or already closed.",
                    )}
                  >
                    <UnplugIcon className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuItem>
                );
              })}
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
                  appear, so a menu that stays short is worth more.

                  "Reconnect all" over "Retry all", which is what this said
                  first. The set is mixed: some of these panes connected and
                  dropped, some were refused and never connected at all, and the
                  buttons they wear differ for exactly that reason (Reconnect
                  and Try again). One word has to cover both. Reconnect is a
                  slight stretch for a session that never got up, and retry was
                  a stretch for one that ran for an hour, but reconnect is the
                  one an operator reads as the thing they want, which is the
                  test that matters in a menu. */}
              {retryableCount > 0 && (
                <DropdownMenuItem
                  onSelect={onReconnectAll}
                  {...hint(
                    retryableCount === 1
                      ? "Reconnect the one session that dropped or was refused. Sessions still connecting, and any waiting on a host-key answer, are left alone."
                      : `Reconnect all ${retryableCount} sessions that dropped or were refused, in one go. Sessions still connecting, and any waiting on a host-key answer, are left alone.`,
                  )}
                >
                  <RefreshCwIcon />
                  Reconnect all
                  <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">
                    {retryableCount}
                  </span>
                </DropdownMenuItem>
              )}

              {/* The other answer to the same tabs, and it shares Reconnect
                  all's count on purpose: the pane you would reconnect is the
                  pane you would give up on, so a reader who has understood one
                  entry has understood both. No confirmation, unlike Close all
                  and unlike its own twin above, because every tab this touches
                  is already dead, its shell already gone; there is nothing here
                  to interrupt, and nothing it starts. */}
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

              {/* The bulk form of the unplug button on every row above, and it
                  sits here rather than up with the repairs because it is not
                  one: those two are about tabs that have already lost their
                  shells, and this one takes shells away.

                  Two sessions is where it appears, because at one it is the row
                  button with extra steps -- the unplug is right there, four
                  pixels from the session it belongs to, and a second control
                  doing the same thing to the same tab is only a way to make the
                  menu longer.

                  Above Close all deliberately, in the order somebody works
                  through them: disconnecting keeps the scrollback and the tabs,
                  so it is the reversible half of the pair and belongs in front
                  of the one that throws everything away. */}
              {openIds.size >= 2 && (
                <DropdownMenuItem
                  onSelect={onDisconnectAll}
                  {...hint(
                    `End the shell on all ${openIds.size} connected sessions and keep every tab. What each printed stays on screen, and each pane offers Reconnect.`,
                  )}
                >
                  <UnplugIcon />
                  Disconnect all
                  <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">
                    {openIds.size}
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
