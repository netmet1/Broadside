import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/tauri/hosts";
import { type PaneEntry, type PaneSide } from "@/pages/sftp/FilePane";
import { nameProblem } from "@/pages/sftp/model";

/** What is being renamed, and on which side. */
export type RenameTarget = { side: PaneSide; entry: PaneEntry };

/**
 * Asks for a new name for one file or folder. The name box opens with the
 * name's stem selected (everything before the extension), as Explorer does,
 * so typing replaces the name and keeps the `.txt`.
 *
 * A failed rename keeps the dialog open with the reason under the box, so a
 * name that is taken or not allowed can be fixed where it was typed. A name
 * the side can't take is caught while it is typed and Rename stays disabled.
 */
export function RenameDialog({
  target,
  whereLabel,
  onClose,
  onRename,
}: {
  target: RenameTarget | null;
  /** Where the entry lives, shown so the operator knows which side it is. */
  whereLabel: string;
  onClose: () => void;
  /** Resolves when the rename landed; rejects with the reason it didn't. */
  onRename: (target: RenameTarget, newName: string) => Promise<unknown>;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      {target && (
        // Keyed on the entry, so each rename starts from a fresh form.
        <RenameForm
          key={`${target.side}:${target.entry.path}`}
          target={target}
          whereLabel={whereLabel}
          onClose={onClose}
          onRename={onRename}
        />
      )}
    </Dialog>
  );
}

function RenameForm({
  target,
  whereLabel,
  onClose,
  onRename,
}: {
  target: RenameTarget;
  whereLabel: string;
  onClose: () => void;
  onRename: (target: RenameTarget, newName: string) => Promise<unknown>;
}) {
  const { entry, side } = target;
  const [name, setName] = useState(entry.name);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const problem = trimmed === entry.name ? null : nameProblem(side, trimmed);
  const canSubmit = !pending && trimmed !== entry.name && problem === null;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setFailed(null);
    try {
      await onRename(target, trimmed);
      onClose();
    } catch (e) {
      setFailed(errorMessage(e));
      setPending(false);
    }
  };

  // Everything before the last dot for a file; the whole name for a folder, or
  // for a dot-file like `.bashrc` whose "extension" is the whole of it.
  const stemEnd = () => {
    const dot = entry.name.lastIndexOf(".");
    return entry.kind !== "dir" && dot > 0 ? dot : entry.name.length;
  };

  return (
    <DialogContent
      keepOpenOnOutsideClick
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(0, stemEnd());
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename</DialogTitle>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="rename-entry" className="text-xs font-normal">
          New name for <span className="font-mono break-all">{entry.name}</span>{" "}
          ({whereLabel})
        </Label>
        <Input
          id="rename-entry"
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setFailed(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          aria-invalid={problem !== null || failed !== null}
          autoComplete="off"
          spellCheck={false}
        />
        {(problem ?? failed) && (
          <p className="text-xs break-words text-destructive">{problem ?? failed}</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!canSubmit}>
          Rename
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
