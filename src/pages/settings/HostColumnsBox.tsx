import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useColumnDrag } from "@/lib/columnDrag";
import {
  HIDEABLE_COLUMNS,
  ORDERABLE_COLUMNS,
  saveColumnOrder,
} from "@/lib/hostColumns";
import { useHint } from "@/lib/status";

/**
 * The two settings about the Hosts table's columns, boxed together with the one
 * button that puts them both back.
 *
 * They were a checkbox row on their own; the order is a second thing about the
 * same table, and a Reset that quietly took in the whole Appearance section
 * would be a nasty surprise, so the box is what says what the button's reach
 * is.
 *
 * The chips are draggable, not just a readout. Reordering from the table itself
 * is the natural gesture and stays the main one, but every other thing about
 * these columns is set here, and a row of names you can see but not touch
 * invites the drag anyway.
 */
export function HostColumnsBox({
  hiddenCols,
  toggleColumn,
  colOrder,
  resetColumns,
}: {
  hiddenCols: Set<string>;
  toggleColumn: (id: string, show: boolean) => void;
  colOrder: string[];
  resetColumns: () => void;
}) {
  const hint = useHint();
  // Saving is all this has to do: the write announces itself, and both this
  // page and an already-open Hosts table read the new order back off that
  // event. Nothing here has to know the table exists.
  const { dragProps, isTarget } = useColumnDrag(colOrder, saveColumnOrder);

  return (
    <div className="grid gap-3 rounded-lg border border-border/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm">Host table columns</Label>
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => {
            resetColumns();
            toast.success("Host table columns reset");
          }}
          {...hint(
            "Show every column again, in the order Broadside ships. Nothing else in Settings is touched.",
          )}
        >
          Reset defaults
        </Button>
      </div>
      <div className="grid gap-1.5">
        <p className="text-xs text-muted-foreground">
          Hide nice-to-have columns from the Hosts table. Label, hostname and
          actions always show.
        </p>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 pt-1">
          {HIDEABLE_COLUMNS.map((col) => (
            <label
              key={col.id}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={!hiddenCols.has(col.id)}
                onChange={(e) => toggleColumn(col.id, e.target.checked)}
              />
              {col.label}
            </label>
          ))}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs font-normal text-muted-foreground">
          Column order
        </Label>
        <p className="text-xs text-muted-foreground">
          Drag a chip onto another to move that column, or drag a column's name
          in the Hosts table itself. The order is remembered across restarts.
        </p>
        <div className="flex flex-wrap gap-1 pt-0.5">
          {colOrder.map((id) => {
            const col = ORDERABLE_COLUMNS.find((c) => c.id === id);
            if (!col) return null;
            const hidden = hiddenCols.has(id);
            return (
              <span
                key={id}
                {...dragProps(id)}
                className={`cursor-grab rounded border px-1.5 py-0.5 text-[11px] active:cursor-grabbing ${
                  hidden
                    ? "border-dashed border-border/60 text-muted-foreground/60"
                    : "border-border/70"
                }${isTarget(id) ? " bg-primary/20 ring-1 ring-primary/50" : ""}`}
                title={
                  hidden
                    ? "Hidden. Drag to move this column"
                    : "Drag to move this column"
                }
              >
                {col.label}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
