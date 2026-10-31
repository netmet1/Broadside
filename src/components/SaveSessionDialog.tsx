import { useState } from "react";
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
import { SecretInput } from "@/components/SecretInput";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/tauri/hosts";
import { saveSession, type OtlogLine } from "@/lib/tauri/logs";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Built lazily on save so the dialog always captures the latest output. */
  buildLines: () => OtlogLine[];
};

/** Default session filename: `YYYY-MM-DD-HH-MM-SS-session.otlog` in *UTC*.
 * The datetime is prepended (so files sort chronologically by name) and uses
 * UTC for an unambiguous, machine-comparable stamp. */
function defaultSessionName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}` +
    `-session.otlog`
  );
}

/** Save-to-.otlog flow (D-010): optional passphrase → native save dialog. */
export function SaveSessionDialog({ open, onOpenChange, buildLines }: Props) {
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);

  // Clear the passphrase as the dialog closes, and re-hide it. Adjusted during
  // render rather than in an effect: it is state derived from a prop, which is
  // React's documented way to reset it, and an effect would leave the old
  // passphrase in the box for one paint. A secret is the last thing that should
  // linger a frame longer than it has to.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setPassphrase("");
      setShow(false);
    }
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const path = await saveDialog({
        title: "Save session",
        defaultPath: defaultSessionName(),
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
      <DialogContent className="sm:max-w-md" keepOpenOnOutsideClick>
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
          <SecretInput
            id="otlog-passphrase"
            noun="passphrase"
            shown={show}
            onShownChange={setShow}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="off"
          />
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
