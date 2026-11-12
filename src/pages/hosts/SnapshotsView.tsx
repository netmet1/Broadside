import { useState } from "react";
import {
  CheckIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useHint } from "@/lib/status";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  deleteSnapshot,
  renameSnapshot,
  type Snapshot,
} from "@/lib/tauri/snapshots";

function tabCount(s: Snapshot): number {
  return s.workspaces.reduce((n, w) => n + w.items.length, 0);
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The Library's Snapshots side: every saved snapshot, newest first. A snapshot
 * has no editor. It is opened, renamed, taken again from what is open now, or
 * deleted.
 */
export function SnapshotsView({
  snapshots,
  loading,
  canRetake,
  onOpen,
  onRetake,
  onChanged,
}: {
  snapshots: Snapshot[];
  loading: boolean;
  /** Something is open to take the snapshot from. */
  canRetake: boolean;
  onOpen: (s: Snapshot) => void;
  /** Resolves true once the snapshot was taken again. */
  onRetake: (s: Snapshot) => Promise<boolean>;
  onChanged: () => void;
}) {
  const hint = useHint();
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [retaking, setRetaking] = useState<Snapshot | null>(null);
  const [deleting, setDeleting] = useState<Snapshot | null>(null);

  const commitRename = async () => {
    const r = renaming;
    if (!r) return;
    setRenaming(null);
    if (!r.name.trim()) return;
    try {
      const s = await renameSnapshot(r.id, r.name.trim());
      onChanged();
      toast.success(`Renamed to "${s.name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const runDelete = async () => {
    const d = deleting;
    setDeleting(null);
    if (!d) return;
    try {
      await deleteSnapshot(d.id);
      onChanged();
      toast.success(`Deleted "${d.name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:overflow-visible">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-28 text-right">Workspaces</TableHead>
            <TableHead className="w-20 text-right">Tabs</TableHead>
            <TableHead className="w-48">Saved</TableHead>
            <TableHead className="w-40 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : (
            snapshots.map((s) => (
              <TableRow
                key={s.id}
                className="group cursor-default"
                onDoubleClick={() => renaming?.id !== s.id && onOpen(s)}
              >
                <TableCell className="font-medium">
                  {renaming?.id === s.id ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void commitRename();
                      }}
                    >
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        maxLength={200}
                        aria-label="Snapshot name"
                        className="h-7 w-64 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
                      />
                      <button
                        type="submit"
                        aria-label="Save the name"
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <CheckIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenaming(null)}
                        aria-label="Keep the old name"
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <XIcon className="h-4 w-4" />
                      </button>
                    </form>
                  ) : (
                    <span
                      {...hint(
                        s.workspaces.map((w) => `${w.name} (${w.items.length})`).join(", "),
                      )}
                    >
                      {s.name}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {s.workspaces.length}
                </TableCell>
                <TableCell className="text-right tabular-nums">{tabCount(s)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {when(s.updated_at)}
                </TableCell>
                <TableCell className="text-right">
                  <div
                    className="flex justify-end gap-1"
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <IconButton
                      label={`Open ${s.name}`}
                      hint={`Open every workspace in "${s.name}" on the Terminals tab. Double-clicking the row does the same`}
                      onClick={() => onOpen(s)}
                    >
                      <PlayIcon className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={`Rename ${s.name}`}
                      hint="Give this snapshot a new name. What it holds is unchanged"
                      onClick={() => setRenaming({ id: s.id, name: s.name })}
                    >
                      <PencilIcon className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={`Update ${s.name}`}
                      hint={
                        canRetake
                          ? "Replace what this snapshot holds with the workspaces open now (asks first)"
                          : "Open some workspaces first: this replaces the snapshot with what is open"
                      }
                      disabled={!canRetake}
                      onClick={() => setRetaking(s)}
                    >
                      <RefreshCwIcon className="h-4 w-4" />
                    </IconButton>
                    <IconButton
                      label={`Delete ${s.name}`}
                      hint="Delete this snapshot (asks first). Nothing open is touched"
                      danger
                      onClick={() => setDeleting(s)}
                    >
                      <Trash2Icon className="h-4 w-4" />
                    </IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <AlertDialog
        open={retaking !== null}
        onOpenChange={(o) => {
          if (!o) setRetaking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update &ldquo;{retaking?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              What it holds now ({retaking?.workspaces.length} workspaces) is
              replaced with the workspaces open on the Terminals tab. It keeps its
              name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const r = retaking;
                setRetaking(null);
                if (r) void onRetake(r).then((ok) => ok && onChanged());
              }}
            >
              Update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              The snapshot goes. The hosts, shells and profiles it names are not
              touched, and neither is anything open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void runDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IconButton({
  label,
  hint: hintText,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const hint = useHint();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      aria-label={label}
      className={
        danger
          ? "rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-500"
          : "rounded p-1 text-muted-foreground not-disabled:hover:bg-accent not-disabled:hover:text-foreground disabled:opacity-40"
      }
      {...hint(hintText)}
    >
      {children}
    </button>
  );
}
