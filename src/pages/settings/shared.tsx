import { type ReactNode } from "react";
import {
  SquareAsteriskIcon,
  SquareTerminalIcon,
  TerminalIcon,
} from "lucide-react";

import { type ShortcutScope } from "@/lib/tauri/settings";

export function SectionHeading({
  title,
  hint,
}: {
  title: string;
  hint?: ReactNode;
}) {
  return (
    <div>
      <h2 className="font-heading text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Leading icon for a shortcut's scope, shown on the Settings page: SSH/WSL use
 * the host/terminal icon, Command Prompt / PowerShell use the square terminal,
 * and a command that runs in both uses the square-asterisk (any shell). */
export function ScopeIcon({ scope }: { scope: ShortcutScope }) {
  const Icon =
    scope === "both"
      ? SquareAsteriskIcon
      : scope === "local"
        ? SquareTerminalIcon
        : TerminalIcon;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}
