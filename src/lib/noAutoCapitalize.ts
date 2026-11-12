/**
 * No automatic capitals in the app's text boxes on a Mac.
 *
 * macOS capitalises the first letter typed into a text field when "Capitalize
 * words automatically" is on in its Keyboard settings, which it is by default,
 * and the app's web view follows it. Almost nothing typed here is a sentence:
 * a command, a host name, a user name, a path or a label, and a command
 * capitalised to `Df -h` does not run. So every text box is marked
 * `autocapitalize="off"`.
 *
 * Only the capitals. Spelling correction (`autocorrect`, `spellcheck`) is left
 * as each box already has it: the operator may well want a misspelt word
 * caught, and a box that must not be corrected (the Composer, the terminal's
 * own input) already says so itself.
 *
 * Done once for the whole app rather than on each box, because there are many
 * and new ones keep arriving: the attribute is put on a box as the pointer
 * goes down on it (before it takes focus) and as it takes focus (for Tab and
 * for focus moved by code). A box that already says what it wants is left as
 * it is. Windows has no automatic capitals, so nothing is installed there.
 */

import { IS_MAC } from "@/lib/platform";

/** Input types that take free text. The rest (checkboxes, colours, ranges,
 * files) have nothing to capitalise. */
const TEXT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
]);

function takesText(el: EventTarget | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return TEXT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase());
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function markNoCapitals(e: Event) {
  const el = e.target;
  if (takesText(el) && !el.hasAttribute("autocapitalize")) {
    el.setAttribute("autocapitalize", "off");
  }
}

/** Installs the listeners; call once at start. Capture phase, so a handler
 * that stops the event further down cannot keep a box from being marked. */
export function installNoAutoCapitalize(): void {
  if (!IS_MAC) return;
  document.addEventListener("pointerdown", markNoCapitals, true);
  document.addEventListener("focusin", markNoCapitals, true);
}
