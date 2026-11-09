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
 * The grid's save-sizes button asks before it writes over a template's sizes.
 * It is offered whenever the grid holds a saved template's sessions, not only
 * a grid that template opened, so one press could replace the sizes of a
 * template the user never meant to touch (smoke test 87-3). Open while `name`
 * is set.
 */
export function SaveSizesConfirm({
  name,
  onSave,
  onCancel,
}: {
  name: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={name !== null}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Save these sizes to &quot;{name}&quot;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            The template&apos;s tile widths and row heights are replaced with
            this grid&apos;s, so opening it lays the grid out like this. Its
            sessions stay as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onSave}>Save sizes</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
