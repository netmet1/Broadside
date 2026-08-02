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

/** What the caller needs to drive, and to suppress, when the pointer activates
 * a tile. */
export type GridFocus = {
  /** Spread onto each grid tile wrapper. */
  tileProps: (sessionId: string) => {
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
  };
  /** True when the activation being processed came from the pointer, so the
   * tab-centering and tile-scrolling effects can sit that one out. Read during
   * render of those effects, hence a ref rather than state. */
  activatedByPointer: React.RefObject<boolean>;
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
  chromeRef,
  chromeKeyboard,
}: {
  gridMode: boolean;
  activeId: string | null;
  /** A tile is being drag-resized: the pointer is sweeping across tiles on
   * purpose and must not select any of them. */
  resizing: boolean;
  onActivate: (id: string) => void;
  /** Moves real DOM keyboard focus into that pane's terminal. */
  focusTerminal: (id: string) => void;
  chromeRef: React.RefObject<HTMLDivElement | null>;
  chromeKeyboard: boolean;
}): GridFocus {
  // Last pointer position we acted on. `pointermove` is used rather than
  // `pointerenter` precisely because enter also fires when the layout shifts
  // under a stationary mouse -- a tile closing, the grid reflowing -- which
  // would hand focus to whatever slid beneath the cursor.
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const activatedByPointer = useRef(false);

  // Deliberate intent beats an idle cursor.
  //
  // The classic focus-follows-mouse complaint: your mouse is parked over TG3
  // while you read it, you click TG1's tab (or press Alt+Left) to work in TG1,
  // and that lands correctly because a stationary mouse fires no pointermove --
  // then you nudge the mouse two pixels and focus snaps back to TG3. A movement
  // threshold does not fix this, it only delays it.
  //
  // So a non-pointer activation arms this, and it clears only when the pointer
  // actually *leaves* the tile it is resting over. Nudging in place changes
  // nothing; moving to another tile resumes normal behaviour at once.
  const suppressed = useRef(false);
  const noteDeliberateActivation = useCallback(() => {
    if (activatedByPointer.current) return;
    suppressed.current = true;
  }, []);

  // Leaving grid mode drops the suppression, so returning to it is not stuck in
  // whatever state the last tab-click left behind.
  useEffect(() => {
    if (!gridMode) {
      suppressed.current = false;
      lastPos.current = null;
    }
  }, [gridMode]);

  const tileProps = useCallback(
    (sessionId: string) => ({
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        if (!gridMode || resizing) return;
        // A selection drag that crosses a tile boundary must not switch panes
        // out from under the drag.
        if (e.buttons !== 0) return;
        // Real movement only. A pointermove can also fire from the element
        // moving beneath a still cursor.
        const prev = lastPos.current;
        if (prev && prev.x === e.clientX && prev.y === e.clientY) return;
        lastPos.current = { x: e.clientX, y: e.clientY };
        if (suppressed.current) return;
        if (sessionId === activeId) return;

        // Ctrl+Shift+T deliberately parks focus in the chrome strip, and Tab
        // wraps around inside it. Sweeping the mouse across the grid must not
        // yank that away.
        if (chromeKeyboard) return;
        const active = document.activeElement as HTMLElement | null;
        if (chromeRef.current?.contains(active ?? null)) return;
        // Typing anywhere that is not a terminal -- the shortcut box, the
        // composer, a search field, a dialog -- outranks the mouse. Without
        // this, moving the pointer over the grid mid-word sends the rest of the
        // word to a host.
        if (active && isTextEntry(active)) return;
        // A modal is open: it owns input until it is dismissed.
        if (document.querySelector("[data-slot='dialog-overlay'], [role='alertdialog']")) {
          return;
        }

        activatedByPointer.current = true;
        onActivate(sessionId);
        focusTerminal(sessionId);
        // Cleared on a microtask so the effects that run for this activation
        // (tab centering, tile scroll-into-view) see it set and skip, while the
        // next activation from any source starts clean.
        queueMicrotask(() => {
          activatedByPointer.current = false;
        });
      },
      onPointerLeave: () => {
        // The cursor genuinely moved off this tile, so a deliberate activation
        // has had its stay of execution.
        suppressed.current = false;
      },
    }),
    [
      gridMode,
      resizing,
      activeId,
      chromeKeyboard,
      chromeRef,
      onActivate,
      focusTerminal,
    ],
  );

  return { tileProps, activatedByPointer, noteDeliberateActivation };
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
