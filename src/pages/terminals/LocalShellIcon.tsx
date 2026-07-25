import { SquareTerminalIcon, TerminalIcon } from "lucide-react";

/** Tab/menu icon for a local shell. WSL and custom POSIX terminals (Git Bash
 * and the like) are grouped with SSH hosts under the terminal icon; the Windows
 * shells use the square-terminal icon.
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
    kind === "wsl" || kind === "posix" ? TerminalIcon : SquareTerminalIcon;
  return <Icon className={className} />;
}
