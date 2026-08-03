/**
 * Whether something on screen already owns the Escape key.
 *
 * Two of Broadside's fullscreens come back out on Esc: a maximized terminal
 * (App) and the fullscreen grid (TerminalsPage). Both listen on `window` in the
 * capture phase, because xterm would otherwise swallow the key first, and both
 * then call `stopPropagation()`. That is a big hammer: it fires before every
 * other Esc handler in the app and stops the event dead, so without a check
 * first, going fullscreen would quietly take Esc away from a dialog that is up
 * or a find bar that is open.
 *
 * The two things that can be up while the chrome is hidden:
 *
 *  - **A dialog.** The exit-confirm can appear from a window-close request, and
 *    a host-key prompt from a reconnect. Radix renders its content only while
 *    open, so the node being in the document is the same thing as it being up.
 *  - **A text field**, which here means the find bar. xterm's own focus target
 *    is a hidden `<textarea>` inside the terminal, so it has to be excluded, or
 *    this would report that the terminal owns Esc every time.
 *
 * Menus and selects are deliberately not checked: the chrome they live in is
 * hidden in both fullscreens, so neither can be open at the point this is
 * asked. If that ever stops being true, they belong on the list.
 */
export function escapeIsSpokenFor(): boolean {
  const el = document.activeElement;
  const inFindBar =
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.closest(".xterm") === null;
  if (inFindBar) return true;
  return (
    document.querySelector('[role="dialog"],[role="alertdialog"]') !== null
  );
}
