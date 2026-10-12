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

/**
 * What a paste sends to the shell, given the clipboard text. It is what xterm's
 * own `paste()` sends (its Clipboard.ts) and what other terminals send, plus
 * one step xterm leaves out.
 *
 * - Line ends become a single CR, which is what Enter sends. Windows copies
 *   lines as CRLF, and sent raw that is two line ends per line: every pasted
 *   line arrived double-spaced, with an empty line between each.
 * - When the program has asked for bracketed paste (bash's readline, zsh, vim
 *   and most modern prompts do), the text is wrapped in its start and end
 *   markers, so it arrives as one pasted block rather than as typing and a
 *   multi-line paste waits for Enter instead of running line by line.
 * - Any markers already inside the text are removed first. A clipboard can
 *   hold anything, and an end marker in the middle of it would close the
 *   bracket early and let the rest run as if it had been typed.
 */
export function pasteBytes(text: string, bracketed: boolean): string {
  // Until nothing changes, because one pass can build a marker out of the
  // pieces around one it removed ("ESC[20" + marker + "1~").
  let body = text;
  for (let prev = ""; prev !== body; ) {
    prev = body;
    // eslint-disable-next-line no-control-regex -- ESC is what is being matched
    body = body.replace(/\x1b\[20[01]~/g, "");
  }
  body = body.replace(/\r?\n/g, "\r");
  return bracketed ? `\x1b[200~${body}\x1b[201~` : body;
}
