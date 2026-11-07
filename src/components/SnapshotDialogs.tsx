import { useState } from "react";

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
import { SerialLeftOutNote } from "@/components/SerialLeftOutNote";
import { snapshotHolds } from "@/lib/sessionPrefs";
import type { PendingSnapshot } from "@/pages/terminals/useSnapshots";

/**
 * Name a new snapshot of the open workspaces. `workspaces` and `tabs` say
 * what it will hold, so nobody saves one expecting something else, and a
 * warning says when serial consoles are left out.
 */
export function SaveSnapshotDialog({
  open,
  onOpenChange,
  workspaces,
  tabs,
  serialLeftOut,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: number;
  /** The tabs it will hold: every open tab but the serial consoles. */
  tabs: number;
  /** Serial consoles open, which it cannot hold. */
  serialLeftOut: number;
  /** Resolves true once saved, which closes the dialog. */
  onSave: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await onSave(name.trim());
    setBusy(false);
    if (ok) {
      setName("");
      onOpenChange(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save a snapshot</DialogTitle>
          <DialogDescription>
            Keeps all {workspaces} {workspaces === 1 ? "workspace" : "workspaces"}{" "}
            ({tabs} {tabs === 1 ? "tab" : "tabs"}) with their names, colours and
            grid sizes, to open again from Library &gt; Snapshots.
          </DialogDescription>
        </DialogHeader>
        <SerialLeftOutNote count={serialLeftOut} into="snapshot" />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Snapshot name"
            aria-label="Snapshot name"
            maxLength={200}
            spellCheck={false}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || busy}>
              Save snapshot
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A snapshot opening while tabs are already open: add its workspaces beside
 * them, or close them and open only the snapshot. Says up front whether the
 * sessions will connect or wait on a Connect button.
 */
export function OpenSnapshotDialog({
  pending,
  onResolve,
}: {
  pending: PendingSnapshot | null;
  onResolve: (how: "add" | "replace" | null) => void;
}) {
  const opening = pending
    ? pending.snapshot.workspaces.filter(
        (_, i) => (pending.plans[i]?.sessions.length ?? 0) > 0,
      ).length
    : 0;
  const held = snapshotHolds(opening);
  const tabs = pending?.openTabs ?? 0;
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(o) => {
        if (!o) onResolve(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Open &ldquo;{pending?.snapshot.name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                It has {opening} {opening === 1 ? "workspace" : "workspaces"}, and{" "}
                {tabs} {tabs === 1 ? "tab is" : "tabs are"} open now.
              </p>
              <p>
                <span className="font-medium text-foreground">Add alongside</span>{" "}
                keeps what is open and adds the snapshot&apos;s workspaces.{" "}
                <span className="font-medium text-foreground">Replace</span>{" "}
                closes every open tab, in every workspace, and disconnects them.
              </p>
              <p>
                {held
                  ? "Its sessions will wait, not connected: each workspace shows a Connect button."
                  : "Its sessions connect as they open."}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => onResolve("replace")}
          >
            Replace ({tabs} {tabs === 1 ? "tab" : "tabs"} close)
          </AlertDialogAction>
          <AlertDialogAction onClick={() => onResolve("add")}>
            Add alongside
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
