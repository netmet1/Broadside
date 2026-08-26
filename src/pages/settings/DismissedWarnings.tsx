import { useEffect, useState } from "react";
import { BellRingIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DISMISSED_WARNINGS_EVENT,
  DISMISSIBLE_WARNINGS,
  dismissedWarnings,
  restoreWarnings,
} from "@/lib/dismissedWarnings";
import { useHint } from "@/lib/status";

/**
 * The way back from a "do not warn me again" checkbox.
 *
 * A dialog that can be silenced forever with no control anywhere to bring it
 * back is not a preference, it is a one-way door, and the person who walks
 * through it is usually not the person who later inherits the machine. This is
 * the other side of that door: what has been turned off, by name, and one
 * button that turns it all back on.
 *
 * In Security rather than Appearance because what these warnings are about is
 * connections opening unattended and host references leaving the machine.
 */
export function DismissedWarnings() {
  const hint = useHint();
  const [off, setOff] = useState<Set<string>>(dismissedWarnings);
  useEffect(() => {
    const reload = () => setOff(dismissedWarnings());
    window.addEventListener(DISMISSED_WARNINGS_EVENT, reload);
    // The second window a user may have open wrote it; `storage` is the only
    // event that crosses documents.
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(DISMISSED_WARNINGS_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  const silenced = DISMISSIBLE_WARNINGS.filter((w) => off.has(w.id));

  return (
    <div className="max-w-xl space-y-3 rounded-md border border-border/40 p-4">
      <div className="flex items-center gap-2">
        <BellRingIcon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Dismissed warnings</h3>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {silenced.length === 0 ? "None" : `${silenced.length} off`}
        </span>
      </div>
      {silenced.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Every warning that can be turned off is currently on. When one is
          dismissed with its &ldquo;don&apos;t warn me again&rdquo; box, it is
          listed here so it can be put back.
        </p>
      ) : (
        <ul className="space-y-2">
          {silenced.map((w) => (
            <li key={w.id} className="text-xs">
              <span className="font-medium text-foreground">{w.label}</span>
              <span className="block text-muted-foreground">{w.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={silenced.length === 0}
        onClick={() => {
          restoreWarnings();
          toast.success("Warnings restored");
        }}
        {...hint(
          silenced.length === 0
            ? "Nothing is silenced, so there is nothing to restore."
            : "Show every dismissed warning again.",
        )}
      >
        Restore dismissed warnings
      </Button>
    </div>
  );
}
