import { useState } from "react";
import { toast } from "sonner";

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
import { type Host, deleteHost, errorMessage } from "@/lib/tauri/hosts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: Host | null;
  onDeleted: () => void;
};

export function DeleteHostDialog({ open, onOpenChange, host, onDeleted }: Props) {
  const [submitting, setSubmitting] = useState(false);

  const confirm = async () => {
    if (!host) return;
    setSubmitting(true);
    try {
      await deleteHost(host.id);
      toast.success(`Deleted ${host.label}`);
      onDeleted();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete host?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete{" "}
            <span className="font-semibold text-foreground">{host?.label}</span>
            {host && ` (${host.username}@${host.hostname})`}. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={confirm}
            disabled={submitting}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
