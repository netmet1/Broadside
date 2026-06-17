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
import { errorMessage, unlockCredentials } from "@/lib/tauri/hosts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUnlocked: () => void;
};

export function UnlockDialog({ open, onOpenChange, onUnlocked }: Props) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleUnlock = async () => {
    if (password.length === 0) {
      toast.error("Master password required");
      return;
    }
    setSubmitting(true);
    try {
      const ok = await unlockCredentials(password);
      if (ok) {
        toast.success("Credentials unlocked");
        setPassword("");
        onUnlocked();
        onOpenChange(false);
      } else {
        toast.error("Wrong master password");
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
          <DialogTitle>Unlock credentials</DialogTitle>
          <DialogDescription>
            Your computer's secure credential store isn't available. Enter your
            master password to unlock your saved passwords. If this is your first
            time, pick any password. It will be used to protect new passwords
            you save.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="master">Master password</Label>
          <Input
            id="master"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            Skip
          </Button>
          <Button type="button" onClick={handleUnlock} disabled={submitting}>
            Unlock
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
