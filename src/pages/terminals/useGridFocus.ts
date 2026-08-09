/**
 * Focus follows the mouse, in grid mode.
 *
 * Before this, a grid of terminals had *three* separate notions of "the pane
 * you mean", and showed none of them:
 *
 *   - right-click paste, copy-on-select and Ctrl+wheel zoom went to the pane
 *     under the **pointer** (they are listeners on each pane's own container);
 *   - typed keys went to the pane holding **DOM focus**;
 *   - Find and the shortcut bar went to **`activeId`**, set only by a click.
 *
 * So pasting into a tile you were merely hovering worked, and nothing on screen
 * said so. Making hover set `activeId` collapses all three into one, and the
 * host-colour ring that already marks the active tile becomes an honest
 * indicator of where every kind of input is about to land. No new visual
 * vocabulary was needed; the highlight simply follows the mouse now.
 *
 * The rest of this file is the part that makes that liveable in a room full of
 * production hosts.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { isWindowFocused } from "@/lib/windowFocus";

/**
 * How still the pointer has to be before the tile under it takes over.
 *
 * The pointer activates the tile it comes to **rest** on, not every tile it
 * crosses. Without this, reaching from a tile in the bottom row up to the
 * shortcut bar handed the grid to each tile on the way and left it with
 * whichever one the pointer passed over last: the ring ended up somewhere
 * nobody chose, the shortcut list was rebuilt for that session's shell, and Go
 * would have run the command there. A wall of production hosts is the worst
 * possible place for "whichever one was on the way".
 *
 * Every real move restarts the clock, so a crossing never fires **whatever this
 * number is**: the pointer keeps pushing the deadline ahead of itself and then
 * leaves, and a tile 300px tall crossed at any speed a hand can manage never
 * gets a gap this long between two moves. What the number actually buys is
 * tolerance for a pointer that hesitates, and for a mouse that reports
 * unevenly. So it wants to be as small as it can be and no smaller: a quarter
 * of a second was picked for safety it did not need, and felt like a lag
 * between arriving somewhere and being able to work there.
 *
 * The floor is the reporting interval, not zero. A moving pointer delivers a
 * `pointermove` about every frame, so this has to stay several frames clear of
 * that or an ordinary hitch mid-sweep -- a burst of output repainting a wall of
 * panes, a garbage collection -- reads as a pause and hands over a tile nobody
 * chose. Sixty milliseconds is roughly four frames at 60Hz and more on a faster
 * panel, which is the smallest number with any real margin left in it. Below
 * about forty there is none.
 */
const SETTLE_MS = 60;

/**
 * A dialog is up, and owns the keyboard until it is dismissed.
 *
 * A modal Radix layer makes the body inert, so the pointer cannot reach a tile
 * at all while one is up and none of this runs. The check is here for the two
 * things that still can: a settle that was already armed when it opened and
 * fires from a timer with no such protection, and a window-level shortcut,
 * which goes on working because it listens on `window` rather than inside the
 * tree that was made inert.
 */
const MODAL_SELECTOR = "[data-slot='dialog-overlay'], [role='alertdialog']";

/**
 * A menu or a select is up. That is a different problem from a dialog rather
 * than a smaller one: it is on its way out, and while it is still there its
 * focus scope pulls any focus set outside it straight back in, then puts the
 * keyboard on the trigger button as it goes. A hand-over aimed at a terminal
 * has to wait for that rather than be abandoned.
 */
const MENU_SELECTOR = "[role='menu'], [role='listbox']";

/** Either of them: something that is not the grid is holding the keyboard. */
const LAYER_SELECTOR = `${MODAL_SELECTOR}, ${MENU_SELECTOR}`;

/** What the caller needs to drive, and to suppress, when the pointer activates
 * a tile. */
export type GridFocus = {
  /** Spread onto each grid tile wrapper. */
  tileProps: (sessionId: string) => {
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
    onWheel: () => void;
  };
  /**
   * The session the **pointer** last made active, or null.
   *
   * The two scroll effects on the page read it, and want opposite things from
   * it. The **grid** sits out an activation that came from the pointer: the
   * tile is under the cursor, so it is on screen, and sliding a wall of live
   * terminals about because the mouse crossed one of them is not worth what it
   * buys. The **tab strip** does follow the pointer, because it is the one
   * place that names the session you are about to type into and a tab off the
   * end of the strip names nothing; it reads this only to scroll by the least
   * that makes the tab whole, rather than centring it as a deliberate pick
   * does, so a sweep across the grid does not send it travelling.
   *
   * An id rather than a "this one was the pointer" flag, because a flag has to
   * be cleared on a schedule and the settle now fires from a timer rather than
   * from inside a React event, where the ordering between that clear and the
   * effects reading it is no longer something to rely on. Comparing against
   * `activeId` needs no timing at all.
   */
  pointerActivated: React.RefObject<string | null>;
  /**
   * Activate a session from something that is *not* the pointer: Alt+arrow, the
   * Sessions menu, a tab. Use it in place of the page's own `onActivate` at
   * every one of those, because there are two more things that have to happen
   * with it and they are the same two every time.
   */
  activateDeliberately: (id: string) => void;
};

export function useGridFocus({
  gridMode,
  activeId,
  resizing,
  onActivate,
  focusTerminal,
  chromeKeyboard,
  releaseChrome,
}: {
  gridMode: boolean;
  activeId: string | null;
  /** A tile is being drag-resized: the pointer is sweeping across tiles on
   * purpose and must not select any of them. */
  resizing: boolean;
  onActivate: (id: string) => void;
  /** Moves real DOM keyboard focus into that pane's terminal, and says whether
   * it landed: a pane can be on screen, or hidden from the grid and unable to
   * hold focus at all, and asking is not the same as arriving. */
  focusTerminal: (id: string) => boolean;
  /** Ctrl+Shift+T has deliberately parked the keyboard in the chrome strip. */
  chromeKeyboard: boolean;
  /** Drop that, because the mouse has just used a tile outright. Merely moving
   * the pointer does not: that is the whole point of the flag. */
  releaseChrome: () => void;
}): GridFocus {
  // Last pointer position we acted on. `pointermove` is used rather than
  // `pointerenter` precisely because enter also fires when the layout shifts
  // under a stationary mouse -- a tile closing, the grid reflowing -- which
  // would hand focus to whatever slid beneath the cursor.
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const pointerActivated = useRef<string | null>(null);

  // Read when the settle fires rather than when it was armed. Short as the wait
  // is, it is long enough for any of them to have changed, and a stale read
  // here is a keypress landing on the wrong host.
  //
  // The copies are made in a *layout* effect rather than during render. React
  // forbids a render touching anything outside itself, because a render can be
  // started and discarded, and the compiler enforces it. A layout effect still
  // runs synchronously once the commit is done, before the browser paints and
  // before it can deliver the next mousemove or keypress, so nothing here can
  // read a value older than what is on screen. A passive `useEffect` is flushed
  // later and would leave precisely the gap these refs exist to close, which is
  // why this is not that.
  const activeIdRef = useRef(activeId);
  const gridModeRef = useRef(gridMode);
  const resizingRef = useRef(resizing);
  const chromeKeyboardRef = useRef(chromeKeyboard);
  const onActivateRef = useRef(onActivate);
  const focusTerminalRef = useRef(focusTerminal);
  const releaseChromeRef = useRef(releaseChrome);
  useLayoutEffect(() => {
    activeIdRef.current = activeId;
    gridModeRef.current = gridMode;
    resizingRef.current = resizing;
    chromeKeyboardRef.current = chromeKeyboard;
    onActivateRef.current = onActivate;
    focusTerminalRef.current = focusTerminal;
    releaseChromeRef.current = releaseChrome;
  });

  // Deliberate intent beats an idle cursor.
  //
  // The classic focus-follows-mouse complaint: your mouse is parked over TG3
  // while you read it, you press Alt+Left (or pick TG1 from the Sessions menu,
  // or walk the tab strip with the arrow keys) to work in TG1, and that lands
  // correctly because a stationary mouse fires no pointermove -- then you nudge
  // the mouse two pixels and focus snaps back to TG3. A movement threshold does
  // not fix this, it only delays it, and neither does the settle: a nudge is
  // real movement that then stops.
  //
  // So a non-pointer activation arms this, and it clears only when the pointer
  // actually *leaves* the tile it is resting over. Nudging in place changes
  // nothing; moving to another tile and stopping there resumes normal
  // behaviour, as does clicking, which is the pointer saying it outright.
  const suppressed = useRef(false);

  /**
   * Hand the keyboard to a pane's terminal.
   *
   * Grid mode only, because it is the one layout where nothing else does it. In
   * every other layout exactly one pane is on screen and a pane takes the
   * keyboard when it becomes the visible one, which is what makes Alt+Left in
   * Tabs land where it looks like it landed. In a grid every pane is visible at
   * once, so `activeId` moving is the whole of the event: the ring went to the
   * session that was chosen and the keys carried on arriving at the one before
   * it, on another host, with nothing on screen saying so.
   *
   * It gives way to anywhere the keyboard is on purpose: a dialog, the chrome
   * strip after Ctrl+Shift+T, or a box being typed into, which is Find and a
   * tab rename and is the same rule the settle keeps.
   */
  const handKeyboardTo = useCallback((id: string) => {
    if (!gridModeRef.current) return;
    if (chromeKeyboardRef.current) return;
    const before = document.activeElement as HTMLElement | null;
    if (before && isTextEntry(before)) return;
    if (document.querySelector(MODAL_SELECTOR)) return;
    if (focusTerminalRef.current(id)) return;
    // It would not take it. A tile hidden from the grid is `display:none`, and
    // that cannot hold focus at all, so the line above did nothing and the
    // keyboard is still sitting in whichever terminal had it: a different host
    // from the one now ringed and named in the strip. There is nothing to hand
    // it to, so take it off the wrong one instead. Typing then goes nowhere,
    // which is the honest answer to choosing a session with no tile, and every
    // window-level shortcut still works.
    if (before?.closest(".xterm")) before.blur();
  }, []);

  /**
   * A session has been chosen by something that is not the pointer.
   *
   * Both halves of that, together: hold the pointer off, and take the keyboard
   * with you. They were two calls at four call sites, and the second was
   * missing from all four, which is how Alt+Left came to move the ring in a
   * grid while the keys went on landing where they had been.
   */
  const activateDeliberately = useCallback(
    (id: string) => {
      suppressed.current = true;
      pointerActivated.current = null;
      onActivateRef.current(id);
      // A menu is still open, because this was one of its items and it closes
      // on the way out of this handler. Taking the keyboard now would be undone
      // twice over, so wait a frame and take it once the menu has gone. The
      // same wait, for the same reason, that a pane makes before focusing
      // itself on becoming visible.
      if (document.querySelector(MENU_SELECTOR)) {
        requestAnimationFrame(() => handKeyboardTo(id));
        return;
      }
      handKeyboardTo(id);
    },
    [handKeyboardTo],
  );

  const timer = useRef<number | undefined>(undefined);
  const cancel = useCallback(() => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  // Where the pointer is, anywhere in the window. The tile handlers below only
  // hear about the cursor once it has moved over a tile, and the moment a mode
  // change needs to know where it is, is exactly the moment that has not
  // happened yet. Written into the same object every time rather than replacing
  // it: this fires for every move anywhere in the window, and there is no call
  // to hand the collector a few hundred objects a second for two numbers.
  const seenPos = useRef({ x: 0, y: 0, seen: false });
  useEffect(() => {
    const track = (e: PointerEvent) => {
      const p = seenPos.current;
      p.x = e.clientX;
      p.y = e.clientY;
      p.seen = true;
    };
    // Capture, so nothing on the way up can keep this from hearing about a move
    // by stopping the event, and passive because it only ever reads.
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointermove", track, opts);
    return () => window.removeEventListener("pointermove", track, opts);
  }, []);

  // A change of mode, in either direction, drops everything the pointer was
  // holding.
  //
  // This used to reset on the way *out* of grid mode only, which left the way
  // in carrying whatever the last deliberate activation had set. Clicking a tab
  // is a deliberate activation and the tab strip is there in Tab mode too, so
  // the ordinary round trip -- switch to Tabs, pick a tab, switch back to Grid
  // -- arrived with the suppression still armed. The first tile the pointer
  // came to rest on was then ignored and it took a click to get in, while the
  // *second* tile hovered behaved normally, because leaving the first one is
  // what finally cleared the flag. What the suppression protects is a cursor
  // resting over a tile while the keyboard picks another one; a mode change has
  // just rebuilt every tile there is, so there is nothing of that left to
  // protect and the flag is only stale state.
  //
  // `lastPos` is seeded on the way in rather than cleared, which is the case
  // the old reset was quietly covering. Re-laying the grid under a still cursor
  // makes the browser send one pointermove at the position it is already at,
  // and against a null `lastPos` that reads as real movement and hands the grid
  // to whichever tile has arrived under the mouse: F11 into a maximized pane
  // and back out is enough to do it. Seeded with where the pointer actually is,
  // that move compares equal and is ignored, and the first genuine one still
  // lands.
  useEffect(() => {
    cancel();
    suppressed.current = false;
    pointerActivated.current = null;
    const p = seenPos.current;
    lastPos.current = gridMode && p.seen ? { x: p.x, y: p.y } : null;
  }, [gridMode, cancel]);

  // A drag-resize starting mid-settle: the pointer is about to sweep across
  // tiles on purpose and a timer armed a moment ago would land inside that.
  useEffect(() => {
    if (resizing) cancel();
  }, [resizing, cancel]);

  useEffect(() => cancel, [cancel]);

  /**
   * The pointer has chosen this tile: ring, `activeId` and the keyboard all
   * move to it together, which is the entire point of the feature.
   *
   * `fromSettle` is what the scroll effects read through `pointerActivated`. A
   * tile the pointer merely came to rest on must not drag the tab strip or the
   * grid along behind it; a tile it pressed is a choice like any other, and one
   * whose tab is worth bringing into view.
   */
  const take = useCallback((sessionId: string, fromSettle: boolean) => {
    pointerActivated.current = fromSettle ? sessionId : null;
    onActivateRef.current(sessionId);
    focusTerminalRef.current(sessionId);
  }, []);

  /**
   * The pointer has used this tile rather than merely arrived at it: a press or
   * a wheel. No settle, no waiting, and it beats both of the things that hold
   * the pointer off. A deliberate activation elsewhere has been overruled by
   * the hand doing something here, and so has Ctrl+Shift+T: the keyboard was
   * put in the strip on purpose, and this is the same mouse taking it back.
   */
  const claim = useCallback(
    (sessionId: string) => {
      cancel();
      if (!gridModeRef.current || resizingRef.current) return;
      suppressed.current = false;
      releaseChromeRef.current();
      if (sessionId === activeIdRef.current) {
        focusTerminalRef.current(sessionId);
        return;
      }
      take(sessionId, false);
    },
    [cancel, take],
  );

  const settle = useCallback(
    (sessionId: string) => {
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        if (!gridModeRef.current || resizingRef.current) return;
        // The window went to sleep during the wait. Checked here as well as at
        // the move, because a pointer that comes to rest and *then* loses the
        // window (Alt+Tab, a notification stealing the foreground) sends no
        // further moves to catch it with.
        if (!isWindowFocused()) return;
        // Ctrl+Shift+T deliberately parks focus in the chrome strip, and Tab
        // wraps around inside it. Sweeping the mouse across the grid must not
        // yank that away.
        if (chromeKeyboardRef.current) return;
        // Typing anywhere that is not a terminal -- the Find box, the
        // composer, a rename, a dialog field -- outranks the mouse. Without
        // this, coming to rest over the grid mid-word sends the rest of the
        // word to a host.
        const active = document.activeElement as HTMLElement | null;
        if (active && isTextEntry(active)) return;
        if (document.querySelector(LAYER_SELECTOR)) return;

        if (sessionId === activeIdRef.current) {
          // Already the tile everything is pointed at, so there is no ring to
          // move. The keyboard is another matter: pressing Go, or anything
          // else in the strip, leaves DOM focus on that control, and coming
          // back to rest over the grid is asking for it back. Without this the
          // only way home was to click, which is what made a strip button feel
          // like a trap.
          //
          // Deliberately ABOVE the suppression check, which is the one place
          // that ordering matters. What suppression protects is a deliberate
          // choice being overruled by an idle cursor, and that can only happen
          // when the tile under the pointer is a *different* one; when it is
          // the chosen tile itself there is nothing left to protect and the
          // trap above is all that is left. The Sessions menu is the case that
          // proved it: it opens `align="end"`, so it is drawn over the
          // top-right tile, and picking a session from it leaves the pointer
          // resting on that tile with no way to reach the only line that
          // clears the flag, which is the pointer *leaving* a tile. Every
          // other tile worked, because walking to it crossed the top-right one
          // on the way out. The top-right tile alone stayed dead until it was
          // clicked.
          focusTerminalRef.current(sessionId);
          return;
        }
        if (suppressed.current) return;
        take(sessionId, true);
      }, SETTLE_MS);
    },
    [cancel, take],
  );

  const tileProps = useCallback(
    (sessionId: string) => ({
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        if (!gridMode || resizing) {
          cancel();
          return;
        }
        // The window is not the one taking keys, and an unfocused window still
        // gets every move the pointer makes over it. Following the mouse here
        // would move the ring, rebuild the shortcut bar for another host and
        // put DOM focus in that tile, all invisibly: come back with Alt+Tab and
        // the keyboard is wherever the mouse drifted, not where it was left.
        if (!isWindowFocused()) {
          cancel();
          return;
        }
        // A selection drag that crosses a tile boundary must not switch panes
        // out from under the drag.
        if (e.buttons !== 0) {
          cancel();
          return;
        }
        // Real movement only. A pointermove can also fire from the element
        // moving beneath a still cursor.
        const prev = lastPos.current;
        if (prev && prev.x === e.clientX && prev.y === e.clientY) return;
        lastPos.current = { x: e.clientX, y: e.clientY };
        settle(sessionId);
      },
      onPointerLeave: () => {
        // Gone before it ever came to rest, which is what a tile on the way to
        // somewhere else looks like.
        cancel();
        // Nothing about which tile is chosen may change while the window is
        // asleep, and this is the one piece of that state a mere movement can
        // still reach. Sweeping across the grid on the way to another
        // application would otherwise quietly spend the protection a
        // deliberate selection is holding, and the first nudge after coming
        // back would hand the grid to whatever the pointer had stopped over.
        if (!isWindowFocused()) return;
        // The cursor genuinely moved off this tile, so a deliberate activation
        // has had its stay of execution.
        suppressed.current = false;
      },
      // A press is the pointer saying so outright, so it does not wait out the
      // settle. It has to be this way round: a right-click paste is aimed at
      // the tile under the pointer, and if the keyboard were still in the last
      // tile the Enter that follows would run the pasted command on a
      // different host.
      onPointerDown: () => claim(sessionId),
      // And so is a wheel. Scrolling back through a tile's output is working in
      // that tile, so the ring belongs there and so does the keyboard: reading
      // what scrolled past and then typing is one gesture, not two. Nothing is
      // taken from the wheel itself, which goes on to the terminal as usual.
      //
      // Not while the window is asleep, though, and this is the one place the
      // wheel and a press have to part company. Windows sends the wheel to
      // whatever is under the pointer without focusing it, so glancing at a
      // tile's history from another application is an ordinary thing to do and
      // must stay a scroll and nothing else. A press is different: it activates
      // the window on its way in, so by the time it is acted on this *is* the
      // focused window.
      onWheel: () => {
        if (!isWindowFocused()) return;
        claim(sessionId);
      },
    }),
    [gridMode, resizing, cancel, settle, claim],
  );

  return { tileProps, pointerActivated, activateDeliberately };
}

/** Whether this element takes typed text. xterm's own hidden textarea is
 * excluded: it *is* the terminal, so having it focused is the normal state and
 * must not block the pointer from moving to another pane. */
function isTextEntry(el: HTMLElement): boolean {
  if (el.closest(".xterm")) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
