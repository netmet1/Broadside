import { CableIcon, SquareTerminalIcon, TerminalIcon } from "lucide-react";

/** Tab/menu icon for a local shell. WSL and custom POSIX terminals (Git Bash
 * and the like) are grouped with SSH hosts under the terminal icon; the Windows
 * shells use the square-terminal icon. A serial console gets a cable, because
 * it is the one session in the app that is a piece of hardware rather than a
 * program, and a tab typing into a switch should not look like a tab typing
 * into a shell.
 *
 * Lives here rather than in `TerminalsPage` so the pieces that render beside
 * the page (the broadcast rail, the broadcast panels) can use it without
 * importing the page itself, which would be a cycle. */
export function LocalShellIcon({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  const Icon =
    kind === "serial"
      ? CableIcon
      : kind === "wsl" || kind === "posix"
        ? TerminalIcon
        : SquareTerminalIcon;
  return <Icon className={className} />;
}
