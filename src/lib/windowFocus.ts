import { useEffect } from "react";

/**
 * Whether this window is the one the operating system is sending keys to.
 *
 * Worth stating why an app needs to ask at all, because for most windows it
 * does not matter. A window that is not focused still receives every mouse
 * event that happens over it: Windows delivers moves to whatever is under the
 * pointer, and since Windows 10 the wheel as well. So hover works, `:hover`
 * paints, xterm's scrollbar fades in, and a grid of terminals looks exactly as
 * alive as it does when it is listening. It is not listening. Keys are going to
 * whatever you were last typing in, which is the sort of mistake that ends with
 * half a command in a chat window, or half a chat message in a root shell.
 *
 * `document.hasFocus()` is the whole answer and needs no state of its own, so
 * this is a plain function rather than a hook: it can be called at the moment a
 * decision is made, which for anything running off a timer is the only reading
 * worth having.
 */
export function isWindowFocused(): boolean {
  return document.hasFocus();
}

/**
 * Mark the document while the window is asleep, so the stylesheet can stop the
 * app looking awake. See the `[data-window-blurred]` rules in `index.css`.
 *
 * Deliberately no React state. Focus changes every time the operator glances at
 * something else, and putting that in state at the root would re-render every
 * mounted page (all of them stay mounted here) for a change that only two CSS
 * rules care about. An attribute on the root element costs nothing and reaches
 * the same places.
 *
 * Call once, from the root component.
 */
export function useWindowBlurredAttr(): void {
  useEffect(() => {
    const sync = () => {
      document.documentElement.toggleAttribute(
        "data-window-blurred",
        !document.hasFocus(),
      );
    };
    // The app can start unfocused: launched behind something else, or restored
    // by a click that lands elsewhere.
    sync();
    // Element focus and blur do not bubble, so these fire for the window alone
    // and not for every terminal that takes the keyboard. `sync` re-reads
    // `hasFocus()` rather than trusting the event name, so a stray one is
    // harmless anyway.
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.documentElement.removeAttribute("data-window-blurred");
    };
  }, []);
}
