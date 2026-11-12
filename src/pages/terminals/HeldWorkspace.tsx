import { PlugZapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHint } from "@/lib/status";

/**
 * What a held workspace shows in place of its terminals: one button, in the
 * middle, that connects them. A snapshot past the Settings > Sessions limit
 * opens every workspace like this, so nothing logs in until somebody asks,
 * and then only this workspace's sessions do (prompts135).
 *
 * It covers the grid rather than leaving each pane's own Reconnect showing,
 * because the point is one deliberate press per workspace, not a dozen
 * buttons that each connect one tab.
 */
export function HeldWorkspace({
  name,
  count,
  onConnect,
}: {
  name: string;
  count: number;
  onConnect: () => void;
}) {
  const hint = useHint();
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--terminal-bg)]">
      <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          {name ? `"${name}" was` : "This workspace was"} opened from a snapshot.
          Its {count} {count === 1 ? "session has" : "sessions have"} not
          connected yet.
        </p>
        <Button
          size="lg"
          onClick={onConnect}
          {...hint(
            `Connect the ${count} ${count === 1 ? "session" : "sessions"} in this workspace. Other workspaces wait for their own button`,
          )}
        >
          <PlugZapIcon />
          Connect {count} {count === 1 ? "session" : "sessions"}
        </Button>
      </div>
    </div>
  );
}
