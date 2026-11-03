import { useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TriangleAlertIcon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { dismissWarning, isWarningDismissed } from "@/lib/dismissedWarnings";

/**
 * Stands in front of the app when another copy of Broadside is already
 * running, and asks before going on. Nothing behind it has mounted yet, so a
 * startup template, saved workspaces and the master-password prompt all wait
 * for the answer, and Quit leaves without having opened anything.
 *
 * Every launch asks again unless "Don't ask me again" was ticked on a launch
 * that went ahead. Quitting never records it, so a tick followed by Quit (or
 * Esc) changes nothing. Settings > Security > Dismissed warnings turns it back
 * on.
 */
export function InstanceGuard({
  others,
  children,
}: {
  /** Copies already running when this one started. */
  others: number;
  children: ReactNode;
}) {
  const [proceed, setProceed] = useState(
    () => others === 0 || isWarningDismissed("second-instance"),
  );
  const [dontAsk, setDontAsk] = useState(false);
  if (proceed) return children;

  const quit = () => {
    getCurrentWindow()
      .destroy()
      .catch((e) => console.error("[instances] failed to quit", e));
  };

  return (
    <div className="h-screen bg-background">
      {/* Always open: the only ways out are the two buttons, and Escape,
          which quits, because quitting is the choice that changes nothing. */}
      <AlertDialog open>
        <AlertDialogContent
          className="data-[size=default]:sm:max-w-md"
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            quit();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="h-5 w-5 text-amber-500" />
              Broadside is already running
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have{" "}
              <span className="font-semibold text-foreground">
                {others} {others === 1 ? "instance" : "instances"}
              </span>{" "}
              of Broadside open. Every instance works on the same hosts,
              credentials and settings, and a change made in one is not always
              picked up by the others. Are you sure you want to open another?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1">
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="accent-primary"
                checked={dontAsk}
                onChange={(e) => setDontAsk(e.target.checked)}
              />
              Don&apos;t ask me again
            </label>
            <p className="text-xs text-muted-foreground">
              You can turn this warning back on in Settings, under Security.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={quit}>Quit</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (dontAsk) dismissWarning("second-instance");
                setProceed(true);
              }}
            >
              Open another instance
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
