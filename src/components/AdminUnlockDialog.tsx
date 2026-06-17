import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/tauri/hosts";
import { verifyAdminPasscode } from "@/lib/tauri/settings";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnlocked: () => void;
};

/** Prompts for the admin passcode to unlock the sensitive controls for this
 * session (sudo auto-fill toggle, credential editing, reset). */
export function AdminUnlockDialog({ open, onOpenChange, onUnlocked }: Props) {
  const [passcode, setPasscode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleUnlock = async () => {
    if (passcode.length === 0) {
      toast.error("Passcode required");
      return;
    }
    setSubmitting(true);
    try {
      const ok = await verifyAdminPasscode(passcode);
      if (ok) {
        toast.success("Unlocked");
        setPasscode("");
        onUnlocked();
        onOpenChange(false);
      } else {
        toast.error("Wrong passcode");
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unlock security controls</DialogTitle>
          <DialogDescription>
            Enter the admin passcode to change the sudo auto-fill setting, edit
            credentials, or reset preferences. It stays unlocked until the app
            is restarted.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="admin-passcode">Admin passcode</Label>
          <Input
            id="admin-passcode"
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleUnlock();
              }
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleUnlock} disabled={submitting}>
            Unlock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
