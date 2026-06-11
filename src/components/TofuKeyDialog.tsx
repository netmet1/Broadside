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
import { type Host, errorMessage } from "@/lib/tauri/hosts";
import { type PresentedKey, trustHostKey } from "@/lib/tauri/ssh";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: Host | null;
  presentedKey: PresentedKey | null;
  /** Called after the key is stored, so the caller can retry the connect. */
  onTrusted: (host: Host) => void;
};

export function TofuKeyDialog({
  open,
  onOpenChange,
  host,
  presentedKey,
  onTrusted,
}: Props) {
  const [submitting, setSubmitting] = useState(false);

  const accept = async () => {
    if (!host || !presentedKey) return;
    setSubmitting(true);
    try {
      await trustHostKey(host.hostname, host.port, presentedKey);
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
          <AlertDialogTitle>Unknown host key</AlertDialogTitle>
          <AlertDialogDescription>
            The authenticity of{" "}
            <span className="font-semibold text-foreground">
              {host?.hostname}:{host?.port}
            </span>{" "}
            can't be established. Verify the fingerprint matches the one shown
            on the server before trusting it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1 rounded-md bg-muted/40 p-3 font-mono text-xs">
          <div className="text-muted-foreground">{presentedKey?.key_type}</div>
          <div className="break-all">{presentedKey?.fingerprint_sha256}</div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={accept} disabled={submitting}>
            Trust this key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
