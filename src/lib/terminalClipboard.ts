/**
 * Copying out of a terminal pane, for both kinds of pane that have one: a
 * Terminals tab (TerminalView) and a skill run's live pane (SkillTerminalPane).
 *
 * The model is Windows Terminal's: **select, then right-click to copy**. It
 * replaced copy-on-select, which copied the moment a mouse drag ended. That
 * made every selection a clipboard write whether or not anyone wanted one, so a
 * drag made only to read a line more carefully threw away whatever was on the
 * clipboard, and the next right-click pasted the line just highlighted instead
 * of the command copied a minute ago.
 */

import type { Terminal } from "@xterm/xterm";
import { toast } from "sonner";

/**
 * Copy the pane's selection and clear it. Returns whether there was anything
 * to copy, which is how a right-click decides between copying and pasting.
 *
 * The toast is the only sign the clipboard changed. The selection is cleared
 * straight away rather than once the write resolves, so it is gone by the time
 * the next right-click arrives and that one pastes, which is the whole rhythm
 * of the gesture: right-click to copy, right-click again to paste.
 */
export function copyTerminalSelection(
  term: Pick<Terminal, "getSelection" | "clearSelection">,
): boolean {
  const sel = term.getSelection();
  if (!sel) return false;
  term.clearSelection();
  navigator.clipboard
    ?.writeText(sel)
    .then(() => toast.success("Copied to clipboard", { duration: 1200 }))
    .catch(() => {});
  return true;
}
