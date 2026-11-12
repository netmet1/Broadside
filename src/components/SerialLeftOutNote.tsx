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

/**
 * The warning a save shows before it leaves serial consoles out. Snapshots and
 * templates hold tabs as references to open again, and a serial console names
 * a port on this machine at a line speed, which neither can hold. The toast
 * after the save said so too, and it was missed (smoke test 87-1), so this
 * goes in the dialog that asks for the save.
 */
export function SerialLeftOutNote({
  count,
  into,
}: {
  count: number;
  into: "snapshot" | "template";
}) {
  if (count <= 0) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
    >
      <TriangleAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <span>
        {count === 1
          ? "A serial console is open. "
          : `${count} serial consoles are open. `}
        A {into} can&apos;t hold serial consoles, so{" "}
        {count === 1 ? "it is" : "they are"} left out.
      </span>
    </p>
  );
}

/**
 * Save as template with serial tiles on the grid: the button goes straight to
 * the Templates editor, so this asks first. Open while `count` is set.
 */
export function SerialLeftOutConfirm({
  count,
  onContinue,
  onCancel,
}: {
  count: number | null;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={count !== null}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save as template without the serial console{count === 1 ? "" : "s"}?</AlertDialogTitle>
          <AlertDialogDescription>
            The other tiles open in the Templates editor, in this order and at
            these sizes, ready to name and save.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <SerialLeftOutNote count={count ?? 0} into="template" />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onContinue}>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
