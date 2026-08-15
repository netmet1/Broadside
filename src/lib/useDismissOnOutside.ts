/**
 * Close a hand-rolled menu when something outside it is pressed, or Escape.
 *
 * Two menus in the app are not Radix's, on purpose: the Terminals launcher and
 * the Hosts tag filter. Both are a plain absolutely-positioned div that opens
 * reliably in the webview and needs no portal, and both therefore have to bring
 * their own dismissal. This is that, in one place, because both of them had the
 * same bug in it.
 *
 * **The event has to be `pointerdown`, not `mousedown`.** Radix opens a menu on
 * pointerdown and calls `preventDefault()` on the way, and preventing the
 * default of a pointerdown suppresses the compatibility mouse events the
 * browser would otherwise synthesise from it. So a `mousedown` listener hears
 * every click in the app except the ones that land on another menu's trigger,
 * which is exactly the click where two menus end up open at once: the launcher
 * stayed on screen while the Sessions menu opened over it (smoke 60-3). Nothing
 * suppresses the pointerdown itself, so listening for that hears everything.
 *
 * Pointer-down rather than click, because a menu should go the moment you press
 * somewhere else rather than when you let go, and because the thing being
 * clicked usually acts on pointerdown too.
 */

import { useEffect, type RefObject } from "react";

export function useDismissOnOutside(
  /** The whole menu, trigger included: a press inside it is not a dismissal. */
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  /** Stable, or the listeners are torn down and rebuilt on every render. */
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}
