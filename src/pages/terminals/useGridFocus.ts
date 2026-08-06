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

import { useCallback, useEffect, useRef } from "react";

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
 * Something is open that owns the keyboard until it is dismissed.
 *
 * A modal Radix layer makes the body inert, so the pointer cannot reach a tile
 * at all while one is up and none of this runs. The check is here for the
 * settle that was already armed when it opened, which fires from a timer with
 * no such protection.
 */
const MODAL_SELECTOR =
  "[data-slot='dialog-overlay'], [role='alertdialog'], [role='menu'], [role='listbox']";

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
   * The tab-centering and tile-scrolling effects sit out an activation that
   * came from the pointer: the tile is under the cursor, so it is on screen
   * already, and scrolling would drag the wall out from under the mouse. An id
   * rather than a "this one was the pointer" flag, because a flag has to be
   * cleared on a schedule and the settle now fires from a timer rather than
   * from inside a React event, where the ordering between that clear and the
   * effects reading it is no longer something to rely on. Comparing against
   * `activeId` needs no timing at all.
   */
  pointerActivated: React.RefObject<string | null>;
  /** Call whenever `activeId` is set by anything that is *not* the pointer, so
   * a resting cursor cannot immediately undo it. */
  noteDeliberateActivation: () => void;
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
  /** Moves real DOM keyboard focus into that pane's terminal. */
  focusTerminal: (id: string) => void;
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
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const gridModeRef = useRef(gridMode);
  gridModeRef.current = gridMode;
  const resizingRef = useRef(resizing);
  resizingRef.current = resizing;
  const chromeKeyboardRef = useRef(chromeKeyboard);
  chromeKeyboardRef.current = chromeKeyboard;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const focusTerminalRef = useRef(focusTerminal);
  focusTerminalRef.current = focusTerminal;
  const releaseChromeRef = useRef(releaseChrome);
  releaseChromeRef.current = releaseChrome;

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
  const noteDeliberateActivation = useCallback(() => {
    suppressed.current = true;
    pointerActivated.current = null;
  }, []);

  const timer = useRef<number | undefined>(undefined);
  const cancel = useCallback(() => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  // Leaving grid mode drops the suppression, so returning to it is not stuck in
  // whatever state the last deliberate activation left behind.
  useEffect(() => {
    if (gridMode) return;
    cancel();
    suppressed.current = false;
    lastPos.current = null;
    pointerActivated.current = null;
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
        if (suppressed.current) return;
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
        if (document.querySelector(MODAL_SELECTOR)) return;

        if (sessionId === activeIdRef.current) {
          // Already the tile everything is pointed at, so there is no ring to
          // move. The keyboard is another matter: pressing Go, or anything
          // else in the strip, leaves DOM focus on that control, and coming
          // back to rest over the grid is asking for it back. Without this the
          // only way home was to click, which is what made a strip button feel
          // like a trap.
          focusTerminalRef.current(sessionId);
          return;
        }
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
      onWheel: () => claim(sessionId),
    }),
    [gridMode, resizing, cancel, settle, claim],
  );

  return { tileProps, pointerActivated, noteDeliberateActivation };
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
