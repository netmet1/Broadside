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
 *
 * It is drawn only while the pointer is on its own row, so every row in the
 * rail needs `group` **and `relative`** on it, and it takes no space at all
 * until then: a rail at rest ends in a straight column of connection dots
 * against the right-hand edge, and the dot steps aside to let the icon in. The
 * dot moving is the point of doing it this way rather than reserving the space,
 * which is the other option and the one that keeps the dot still while the
 * pointer sweeps past.
 *
 * Hidden by going **out of the flow**, not by `display: none`, and that is a
 * keyboard decision rather than a visual one. A row's icon has to be reachable
 * by Tab, and a button that is not in the document cannot be tabbed to, so with
 * `display: none` the icon existed only where focus had already arrived: Tab
 * down the rail visited every icon (focus was on the row above, which drew it),
 * and Shift+Tab back up visited none of them (the row above had no focus yet,
 * so there was nothing there to land on). An absolutely positioned, transparent
 * button is in the tab order at all times and is never focused while invisible,
 * because focus anywhere in the row puts it back in the flow. `right-1` is what
 * keeps it inside the rail while it is out of the flow, since a rail that
 * scrolls vertically will grow a horizontal scrollbar for anything hanging past
 * its edge, visible or not.
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
      className={`absolute right-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground pointer-events-none group-hover:pointer-events-auto group-hover:static group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:static group-focus-within:opacity-100 ${
        pushRight ? "ml-auto" : ""
      }`}
    >
      <TerminalIcon className="h-3.5 w-3.5" />
    </button>
  );
}
