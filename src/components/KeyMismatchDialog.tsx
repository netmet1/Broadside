import { useEffect, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { type Host, errorMessage } from "@/lib/tauri/hosts";
import { type PresentedKey, trustHostKey } from "@/lib/tauri/ssh";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: Host | null;
  storedFingerprint: string | null;
  presented: PresentedKey | null;
  /** Called after the new key replaces the old one, to retry the connect. */
  onTrusted: (host: Host) => void;
};

export function KeyMismatchDialog({
  open,
  onOpenChange,
  host,
  storedFingerprint,
  presented,
  onTrusted,
}: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  const trustNew = async () => {
    if (!host || !presented) return;
    setSubmitting(true);
    try {
      await trustHostKey(host.hostname, host.port, presented);
      onOpenChange(false);
      onTrusted(host);
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
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <TriangleAlertIcon className="h-5 w-5" />
            HOST KEY CHANGED
          </AlertDialogTitle>
          <AlertDialogDescription>
            The key presented by{" "}
            <span className="font-semibold text-foreground">
              {host?.hostname}:{host?.port}
            </span>{" "}
            does not match the one stored from a previous connection. This can
            mean the server was reinstalled, or that the connection is being
            intercepted (man-in-the-middle). The connection was refused.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 font-mono text-xs">
          <div className="space-y-1 rounded-md bg-muted/40 p-3">
            <div className="text-muted-foreground">Stored fingerprint</div>
            <div className="break-all">{storedFingerprint}</div>
          </div>
          <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <div className="text-destructive">
              Presented now ({presented?.key_type})
            </div>
            <div className="break-all">{presented?.fingerprint_sha256}</div>
          </div>
        </div>
        <Label className="flex items-start gap-2 text-xs font-normal text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 accent-destructive"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I verified the server's key actually changed (reinstall, rotation)
          and understand the risk of trusting it.
        </Label>
        <AlertDialogFooter>
          <AlertDialogAction
            variant="destructive"
            onClick={trustNew}
            disabled={!acknowledged || submitting}
          >
            Trust new key
          </AlertDialogAction>
          <AlertDialogCancel autoFocus disabled={submitting}>
            Close
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
