import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { UNMATCHED_CUSTOM } from "@/lib/localShellProfiles";
import type { LocalShell } from "@/lib/tauri/local";
import type { ShellProfileInput } from "@/lib/tauri/shellProfiles";
import { cn } from "@/lib/utils";

/** A profile read from a file, under the name it will be saved as.
 * `originalLabel` is the name in the file, kept so a rename can be shown. */
export type ProfileImportRow = ShellProfileInput & { originalLabel: string };

type Props = {
  /** The profiles to preview, or null when no import is in progress. */
  rows: ProfileImportRow[] | null;
  /** Every shell that can launch here, to say which profiles will not. */
  shells: LocalShell[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/**
 * The preview an import has to pass through before anything is saved.
 *
 * **This dialog is the guard.** A profile's startup command is typed into a
 * shell every time the profile is launched, with nothing checking it on the
 * way, and a file is an easy thing to be handed. No filter can tell a harmful
 * command from a useful one, so instead every command is shown here in full,
 * never truncated, and the person whose machine it is decides. The backend
 * refuses control characters in every field, so what is shown is all there is.
 */
export function ShellProfileImportDialog({
  rows,
  shells,
  busy,
  onCancel,
  onConfirm,
}: Props) {
  const withCommands = rows?.filter((r) => r.startupCommand).length ?? 0;
  const count = rows?.length ?? 0;

  return (
    <Dialog
      open={rows !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Import {count} shell profile{count === 1 ? "" : "s"}?
          </DialogTitle>
          <DialogDescription>
            Nothing is saved until you press Import. New profiles go at the
            bottom of the list, and a name you already use comes in as a
            numbered copy.
          </DialogDescription>
        </DialogHeader>

        {withCommands > 0 && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {withCommands === 1
              ? "One of these runs a startup command"
              : `${withCommands} of these run a startup command`}{" "}
            every time the profile opens, typed into the shell as if you had
            typed it. Read each one below, and only import a file you trust.
          </p>
        )}

        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {rows?.map((r, i) => {
            const shell = shells.find((s) => s.id === r.shellId);
            const renamed = r.label !== r.originalLabel.trim();
            return (
              <li
                key={i}
                className="rounded-md border border-border/60 px-3 py-2 text-sm"
              >
                <div className="font-medium">
                  {r.label}
                  {renamed && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      &quot;{r.originalLabel}&quot; is already taken
                    </span>
                  )}
                </div>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-muted-foreground">Shell</dt>
                  <dd
                    className={cn(
                      !shell && "text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {shell
                      ? shell.label
                      : r.shellId === UNMATCHED_CUSTOM
                        ? r.wantedShell
                          ? `"${r.wantedShell}", a custom terminal that isn't on this machine`
                          : "A custom terminal that isn't on this machine"
                        : `${r.shellId} (not on this machine)`}
                  </dd>
                  <dt className="text-muted-foreground">Folder</dt>
                  <dd className="break-all font-mono">
                    {r.cwd || (
                      <span className="font-sans text-muted-foreground">
                        Home folder
                      </span>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Startup command</dt>
                  <dd>
                    {r.startupCommand ? (
                      <pre className="whitespace-pre-wrap break-all font-mono text-foreground">
                        {r.startupCommand}
                      </pre>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </dd>
                </dl>
              </li>
            );
          })}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy || count === 0}>
            Import {count === 1 ? "profile" : `${count} profiles`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
