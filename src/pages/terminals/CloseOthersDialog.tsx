import { useState } from "react";

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
import type { LocalShell } from "@/lib/tauri/local";
import { kindsPresent } from "@/pages/terminals/sessionKinds";
import type { CloseOthers } from "@/pages/terminals/useCloseOthers";

/**
 * The question Close others asks before closing two or more sessions.
 *
 * Shaped like Close all's, and destructive for the same reason: these shells
 * may be running something. It counts by kind because the menu entry that got
 * here may have been "Close others" on a strip of mixed tabs, and "4 sessions"
 * does not say that one of them is the PowerShell with the build in it.
 */
export function CloseOthersDialog({
  closeOthers,
  shells,
}: {
  closeOthers: CloseOthers;
  /** The launcher's shells, so the kinds are listed in the launcher's order. */
  shells: readonly LocalShell[];
}) {
  const { pending, confirm, cancel, onDialogClosed } = closeOthers;
  // What the dialog says is the last batch it was opened for, kept while it
  // fades out after an answer has emptied `pending`. Adjusted during render and
  // guarded on identity, which `pending` keeps between renders.
  const [shown, setShown] = useState(pending);
  if (pending.length > 0 && pending !== shown) setShown(pending);
  const n = shown.length;
  const kinds = kindsPresent(shown, shells);
  return (
    <AlertDialog
      open={pending.length > 0}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onDialogClosed}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Close {n} other {n === 1 ? "session" : "sessions"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <ul className="space-y-0.5">
                {kinds.map((k) => (
                  <li key={k.kind} className="flex gap-2">
                    <span className="w-6 text-right font-semibold tabular-nums text-foreground">
                      {k.count}
                    </span>
                    <span>{k.label}</span>
                  </li>
                ))}
              </ul>
              <p>
                Anything running in them stops. The tab you asked from stays
                open.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm}>
            Close {n}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
