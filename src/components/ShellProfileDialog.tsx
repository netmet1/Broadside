import { useEffect, useMemo, useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/tauri/hosts";
import { type LocalShell } from "@/lib/tauri/local";
import { type ShellProfile } from "@/lib/localShellProfiles";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shells offered in the dropdown: the detected shells the user has not
   * hidden in Settings, so the profile picker honors the same hide-list as the
   * launcher. */
  shells: LocalShell[];
  /** The profile being edited, or null to create a new one. */
  initial: ShellProfile | null;
  /** Persist the built profile (insert or replace). */
  onSave: (profile: ShellProfile) => void;
};

/** Create/edit form for a saved local-shell launch profile: a shell + a working
 * directory + an optional startup command. Reached from the Terminals "+"
 * launcher. */
export function ShellProfileDialog({
  open,
  onOpenChange,
  shells,
  initial,
  onSave,
}: Props) {
  const [label, setLabel] = useState("");
  const [shellId, setShellId] = useState("");
  const [cwd, setCwd] = useState("");
  const [startupCommand, setStartupCommand] = useState("");

  // Seed the form when the dialog opens (new = blank; edit = the profile).
  useEffect(() => {
    if (!open) return;
    setLabel(initial?.label ?? "");
    setShellId(initial?.shellId ?? shells[0]?.id ?? "");
    setCwd(initial?.cwd ?? "");
    setStartupCommand(initial?.startupCommand ?? "");
  }, [open, initial, shells]);

  // The shell options: the offered shells, plus the profile's own shell if it
  // is not among them (hidden in Settings, or a removed WSL distro) so editing
  // never silently drops it. Flagged as unavailable so the user knows it needs
  // re-enabling (or reinstalling) before it will launch.
  const shellOptions = useMemo(() => {
    const opts = shells.map((s) => ({ id: s.id, label: s.label }));
    if (shellId && !shells.some((s) => s.id === shellId)) {
      opts.push({ id: shellId, label: `${shellId} (unavailable)` });
    }
    return opts;
  }, [shells, shellId]);

  const browse = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        defaultPath: cwd.trim() || undefined,
      });
      if (typeof picked === "string") setCwd(picked);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const trimmedLabel = label.trim();
  const canSave = trimmedLabel.length > 0 && shellId.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      label: trimmedLabel,
      shellId,
      cwd: cwd.trim(),
      startupCommand: startupCommand.trim(),
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit profile" : "New shell profile"}</DialogTitle>
          <DialogDescription>
            A named shell that opens in a chosen folder and, optionally, runs a
            command on start. It appears in the + launcher.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1">
            <Label htmlFor="profile-label">Name</Label>
            <Input
              id="profile-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Your Profile Name"
              autoFocus
            />
          </div>

          <div className="grid gap-1">
            <Label htmlFor="profile-shell">Shell</Label>
            <Select value={shellId} onValueChange={setShellId}>
              <SelectTrigger id="profile-shell" className="w-full">
                <SelectValue placeholder="Choose a shell…" />
              </SelectTrigger>
              <SelectContent>
                {shellOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="profile-cwd">
              Working directory{" "}
              <span className="text-xs text-muted-foreground">(optional)</span>
            </Label>
            <div className="flex gap-2">
              <Input
                id="profile-cwd"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="Leave empty for your home folder"
                className="font-mono text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={browse}
                aria-label="Browse for a folder"
                title="Browse for a folder"
              >
                <FolderOpenIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="profile-startup">
              Startup command{" "}
              <span className="text-xs text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="profile-startup"
              value={startupCommand}
              onChange={(e) => setStartupCommand(e.target.value)}
              placeholder="claude"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Typed into the shell once it opens, as if you'd entered it.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {initial ? "Save changes" : "Create profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
