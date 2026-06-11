import { useEffect, useState } from "react";
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
import { errorMessage } from "@/lib/tauri/hosts";
import { type PresentedKey, trustHostKey } from "@/lib/tauri/ssh";

export type UnknownKeyEntry = {
  hostId: number;
  label: string;
  hostname: string;
  port: number;
  key: PresentedKey;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: UnknownKeyEntry[];
  /** Called with the host ids whose keys were trusted, to retry them. */
  onTrusted: (hostIds: number[]) => void;
};

/**
 * Broadcast-time TOFU accept: all unknown-key hosts from one run in a single
 * dialog with per-row checkboxes (D-034).
 */
export function BatchTofuDialog({
  open,
  onOpenChange,
  entries,
  onTrusted,
}: Props) {
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setChecked(new Set(entries.map((e) => e.hostId)));
  }, [open, entries]);

  const toggle = (hostId: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) {
        next.delete(hostId);
      } else {
        next.add(hostId);
      }
      return next;
    });
  };

  const trustSelected = async () => {
    const selected = entries.filter((e) => checked.has(e.hostId));
    if (selected.length === 0) return;
    setSubmitting(true);
    try {
      for (const entry of selected) {
        await trustHostKey(entry.hostname, entry.port, entry.key);
      }
      onOpenChange(false);
      onTrusted(selected.map((e) => e.hostId));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            Unknown host {entries.length === 1 ? "key" : "keys"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {entries.length === 1 ? "This host" : "These hosts"} presented{" "}
            {entries.length === 1 ? "a key" : "keys"} not seen before. Verify
            the fingerprints before trusting; trusted hosts are retried
            automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="max-h-72 space-y-2 overflow-y-auto">
          {entries.map((entry) => (
            <label
              key={entry.hostId}
              className="flex cursor-pointer items-start gap-3 rounded-md bg-muted/40 p-3"
            >
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={checked.has(entry.hostId)}
                onChange={() => toggle(entry.hostId)}
              />
              <span className="min-w-0 flex-1 font-mono text-xs">
                <span className="block font-sans text-sm font-medium text-foreground">
                  {entry.label}{" "}
                  <span className="font-normal text-muted-foreground">
                    {entry.hostname}:{entry.port}
                  </span>
                </span>
                <span className="text-muted-foreground">{entry.key.key_type}</span>
                <span className="block break-all">
                  {entry.key.fingerprint_sha256}
                </span>
              </span>
            </label>
          ))}
        </div>

        <AlertDialogFooter>
          <AlertDialogAction
            onClick={trustSelected}
            disabled={submitting || checked.size === 0}
          >
            Trust selected ({checked.size}) &amp; retry
          </AlertDialogAction>
          <AlertDialogCancel autoFocus disabled={submitting}>
            Cancel
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
