import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  matchingCustomShell,
  UNMATCHED_CUSTOM,
  type ShellProfile,
} from "@/lib/localShellProfiles";
import { PALETTE } from "@/lib/palette";
import { useShellColors } from "@/lib/useShellColors";

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
  const [color, setColor] = useState("");
  /** The custom shell this profile is asking for, when it has none. Held so a
   * save that does not fix the shell (a rename, a new folder) keeps the note,
   * and carried straight back: the backend drops it the moment the profile
   * names a shell, so this form never has to clear it. */
  const [wantedShell, setWantedShell] = useState("");

  // The native colour picker is open. It is a browser-level popup, drawn over
  // the page and outside our DOM, and it opens *downwards* from a swatch that
  // sits directly above the footer: it lands on Cancel and Save. The click that
  // dismisses it then goes through to whichever button is underneath, so
  // picking a colour and clicking away threw the half-filled form out.
  //
  // While it is up, a transparent shield covers the dialog and swallows exactly
  // one click (see below). Nothing here can reach the popup, which is the point:
  // the shield only ever guards our own controls.
  const [pickerOpen, setPickerOpen] = useState(false);
  const colorInputRef = useRef<HTMLInputElement>(null);

  // `change` on a colour input means the popup has closed and committed, which
  // is the one close we get told about. React's own onChange is the `input`
  // event here and fires continuously while the popup is still up, so it cannot
  // stand in for this. A close with no colour chosen (Escape) reports nothing
  // at all, and the shield's own click is the backstop for that.
  useEffect(() => {
    const el = colorInputRef.current;
    if (!el) return;
    const done = () => setPickerOpen(false);
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, [open]);

  // A profile that points at no shell, naming the custom one it wants, and
  // that shell is on this machine now. The dropdown opens on it rather than on
  // "custom:none (unavailable)", so re-pointing a profile a restore orphaned is
  // Edit then Save. Not done for the operator: nothing about a restored file
  // gets to decide what a click launches, and picking the shell is the moment a
  // person says it should.
  const rematch =
    initial && initial.shellId === UNMATCHED_CUSTOM
      ? matchingCustomShell(shells, initial.wantedShell)
      : undefined;

  // Seed the form when the dialog opens (new = blank; edit = the profile).
  // Adjusted during render rather than in an effect, React's documented way to
  // reset state derived from props: an effect would paint the previous
  // profile's values for one frame before replacing them, which on a dialog
  // that opens over the top of the list is visible.
  const [seed, setSeed] = useState({ open, initial, shells });
  if (seed.open !== open || seed.initial !== initial || seed.shells !== shells) {
    setSeed({ open, initial, shells });
    // Cleared either way: a shield left standing from the last time this dialog
    // was open would eat the first click of the next one.
    setPickerOpen(false);
    if (open) {
      setLabel(initial?.label ?? "");
      setShellId(rematch?.id ?? initial?.shellId ?? shells[0]?.id ?? "");
      setCwd(initial?.cwd ?? "");
      setStartupCommand(initial?.startupCommand ?? "");
      setColor(initial?.color ?? "");
      setWantedShell(initial?.wantedShell ?? "");
    }
  }

  // What the tab would look like with no colour set here: the colour the chosen
  // shell's kind carries. Shown rather than described, because "follow the
  // shell" means nothing until you can see which colour that is.
  const shellColors = useShellColors();
  const inheritedColor =
    shellColors[shells.find((s) => s.id === shellId)?.kind ?? ""] ?? null;

  // The shell options: the offered shells, plus the profile's own shell if it
  // is not among them (hidden in Settings, or a removed WSL distro) so editing
  // never silently drops it. Flagged as unavailable so the user knows it needs
  // re-enabling (or reinstalling) before it will launch.
  const shellOptions = useMemo(() => {
    const opts = shells.map((s) => ({ id: s.id, label: s.label }));
    if (shellId && !shells.some((s) => s.id === shellId)) {
      // A profile pointing at nothing is not naming a shell that got hidden,
      // so it reads as the blank it is rather than as an id.
      opts.push({
        id: shellId,
        label:
          shellId === UNMATCHED_CUSTOM
            ? "No shell yet"
            : `${shellId} (unavailable)`,
      });
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
      color,
      wantedShell,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" keepOpenOnOutsideClick>
        {/* Swallows the click that dismisses the colour popup, so it cannot
            land on Cancel (or Save) underneath. Deliberately covers the whole
            dialog rather than just the footer: the popup can open over any of
            it depending on where the window sits, and "the click that puts the
            picker away does nothing else" is a rule worth being able to state
            in one line. It clears itself on that click, so at most one is ever
            eaten, and it cannot reach the popup, which is not in our DOM. */}
        {pickerOpen && (
          <div
            className="absolute inset-0 z-50"
            aria-hidden="true"
            // Not on pointerdown: clearing there would unmount the shield
            // before the click was dispatched, and the click would find the
            // button after all, which is the bug. preventDefault keeps the
            // press from moving focus onto whatever is beneath.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setPickerOpen(false)}
          />
        )}
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
            {/* Which shell this profile used to open, for a profile that has
                none. A restore never brings custom local shells over, and the
                profile's own name is a poor record of which one it was. */}
            {initial?.shellId === UNMATCHED_CUSTOM && initial.wantedShell && (
              <p className="text-xs text-muted-foreground">
                This profile opened the custom local shell{" "}
                <b>{initial.wantedShell}</b>.{" "}
                {rematch
                  ? "You have one by that name, so it is picked above: save to use it again."
                  : "Add it under Settings > Local shells, then pick it here."}
              </p>
            )}
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

          {/* A colour of its own, because a profile is a purpose rather than a
              language: two profiles on the same pwsh want telling apart the way
              two hosts do, and the shell's own colour cannot do that. Left
              alone it follows the shell, and the swatch on the left shows which
              colour that is rather than making the reader guess. */}
          <div className="grid gap-1">
            <Label>
              Tab colour{" "}
              <span className="text-xs text-muted-foreground">(optional)</span>
            </Label>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setColor("")}
                aria-label="Follow the shell's own colour"
                title="Follow the shell's own colour"
                className={`flex h-7 items-center gap-1.5 rounded-md border-2 px-2 text-xs ${
                  color === "" ? "border-foreground" : "border-transparent"
                }`}
              >
                <span
                  className="h-3.5 w-3.5 rounded-sm border border-border"
                  style={
                    inheritedColor
                      ? { backgroundColor: inheritedColor }
                      : undefined
                  }
                  aria-hidden="true"
                />
                Shell&apos;s colour
              </button>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Pick colour ${c}`}
                  className={`h-7 w-7 rounded-md border-2 ${
                    color.toLowerCase() === c.toLowerCase()
                      ? "border-foreground"
                      : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
              {/* The preview doubles as the button for the native picker, the
                  same arrangement the Hosts form uses. */}
              <span className="relative h-7 w-7 shrink-0">
                <span
                  className="block h-full w-full rounded-md border-2 border-dashed border-border"
                  style={color ? { backgroundColor: color } : undefined}
                  aria-hidden="true"
                />
                <input
                  ref={colorInputRef}
                  type="color"
                  value={color || inheritedColor || "#3b82f6"}
                  onChange={(e) => setColor(e.target.value)}
                  onClick={() => setPickerOpen(true)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Pick any colour"
                  title="Pick any colour"
                />
              </span>
            </div>
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
