import { TerminalIcon } from "lucide-react";

/**
 * The "go to terminal" mark that sits at the end of a rail row, just past the
 * connection dot.
 *
 * Two meanings, because the rails carry two different things. A rail of
 * *sessions* (MultiTerminal, PTY Broadcast) can point at the exact tab it
 * dispatched to, so the icon jumps. Broadcast's rail is a rail of *hosts* and
 * its runs go over an exec channel with no session of their own, so there is
 * nothing to jump to and the icon opens a fresh connection instead. The
 * tooltip says which one you are about to get: "jump" and "open another shell
 * on this box" are not the same click, and a single wording for both would be
 * wrong on one of them.
 */
export function GoToTerminalButton({
  mode,
  onClick,
  pushRight = false,
}: {
  /** `jump` selects an existing tab; `new` opens another connection. */
  mode: "jump" | "new";
  onClick: () => void;
  /** Take the row's spare space, for the rails whose rows have no connection
   * dot to sit behind (the local-shell panels): the icon still wants to line
   * up at the right-hand edge with the rails that do. */
  pushRight?: boolean;
}) {
  const label =
    mode === "jump"
      ? "Go to this terminal"
      : "Open a new terminal connection to this host";
  return (
    <button
      type="button"
      onClick={(e) => {
        // Every rail row is a <label> wrapping its checkbox, and selecting a
        // host on the way to its terminal would be a quiet way to broadcast to
        // the wrong machine. HTML already says a click on interactive content
        // inside a label does not activate the labelled control, so this is
        // belt and braces rather than the load-bearing part: it states the
        // rule here instead of resting on a reader knowing it.
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className={`shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground ${
        pushRight ? "ml-auto" : ""
      }`}
    >
      <TerminalIcon className="h-3.5 w-3.5" />
    </button>
  );
}
