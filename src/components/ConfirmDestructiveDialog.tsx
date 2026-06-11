import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GuardHit } from "@/lib/tauri/broadcast";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  command: string;
  hits: GuardHit[];
  hostLabels: string[];
  onConfirmed: () => void;
};

/** Typed-CONFIRM gate for destructive broadcasts (D-014). */
export function ConfirmDestructiveDialog({
  open,
  onOpenChange,
  command,
  hits,
  hostLabels,
  onConfirmed,
}: Props) {
  const [typed, setTyped] = useState("");
  const armed = typed === "CONFIRM";

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlertIcon className="h-5 w-5" />
            DESTRUCTIVE COMMAND
          </AlertDialogTitle>
          <AlertDialogDescription>
            This command matches{" "}
            {hits.length === 1 ? "a destructive rule" : "destructive rules"}{" "}
            and will run on{" "}
            <span className="font-semibold text-foreground">
              {hostLabels.length}{" "}
              {hostLabels.length === 1 ? "host" : "hosts"}
            </span>
            .
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-3 text-xs">
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono whitespace-pre-wrap break-all">
            {command}
          </pre>
          <ul className="space-y-1">
            {hits.map((h) => (
              <li key={h.rule_id} className="flex items-start gap-2">
                <span className="mt-0.5 text-destructive">⚠</span>
                <span className="text-muted-foreground">{h.description}</span>
              </li>
            ))}
          </ul>
          <div className="break-words text-muted-foreground">
            Targets: {hostLabels.join(", ")}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-input" className="text-xs font-normal">
            Type <span className="font-mono font-semibold">CONFIRM</span> to
            enable Run (case-sensitive)
          </Label>
          <Input
            id="confirm-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogAction
            variant="destructive"
            disabled={!armed}
            onClick={() => {
              onOpenChange(false);
              onConfirmed();
            }}
          >
            Run
          </AlertDialogAction>
          <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
