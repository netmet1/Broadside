import { useEffect, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { toast } from "sonner";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/tauri/hosts";
import { saveSession, type OtlogLine } from "@/lib/tauri/logs";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Built lazily on save so the dialog always captures the latest output. */
  buildLines: () => OtlogLine[];
};

/** Save-to-.otlog flow (D-010): optional passphrase → native save dialog. */
export function SaveSessionDialog({ open, onOpenChange, buildLines }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setShow(false);
    }
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const path = await saveDialog({
        title: "Save session",
        defaultPath: `session-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.otlog`,
        filters: [{ name: "Broadside session", extensions: ["otlog"] }],
      });
      if (typeof path !== "string") return; // user cancelled
      const lines = buildLines();
      await saveSession(path, lines, passphrase.length > 0 ? passphrase : null);
      toast.success(
        `Saved ${lines.length} lines${passphrase ? " (encrypted)" : ""}`,
      );
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save session</DialogTitle>
          <DialogDescription>
            Writes the current broadcast output as a JSONL .otlog file.
            Add a passphrase to encrypt it; leave empty for plaintext.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          <Label htmlFor="otlog-passphrase">
            Passphrase{" "}
            <span className="text-xs text-muted-foreground">(optional)</span>
          </Label>
          <div className="relative">
            <Input
              id="otlog-passphrase"
              type={show ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="pr-9"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
              aria-label={show ? "Hide passphrase" : "Show passphrase"}
            >
              {show ? (
                <EyeOffIcon className="h-4 w-4" />
              ) : (
                <EyeIcon className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            Choose file & save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
