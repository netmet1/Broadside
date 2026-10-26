import { CopyIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react";

import { RowGrip } from "@/components/RowGrip";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useHint } from "@/lib/status";
import type { Template } from "@/lib/tauri/templates";
import type { useRowDrag } from "@/lib/useRowDrag";
import { cn } from "@/lib/utils";

/** What a startup setting is called where it is only being reported. Set in the
 * editor, shown here: the list is where you find out that something opens
 * itself, and the editor is where the choice (and its warning) belongs. */
const STARTUP_CHIP: Record<string, { label: string; hint: string } | null> = {
  off: null,
  launch: {
    label: "Opens at startup",
    hint: "Broadside starts with this template's tabs already made. Nothing connects until you press Reconnect.",
  },
  connect: {
    label: "Connects at startup",
    hint: "Broadside starts by connecting every session in this template. Change it in the editor.",
  },
};

/**
 * The Templates side of the Hosts tab: the list, and the actions that open
 * them.
 *
 * One opens from its row: the play button, or a double-click anywhere on it.
 * Several open from their ticks, through Multi-template above the list, one
 * after another in the order this list shows; the grip beside each tick is how
 * that order is set. (It used to be a radio, on the grounds that nobody means
 * to open two arrangements at once. prompts121 said otherwise.)
 */
export function TemplatesView({
  templates,
  loading,
  checkedIds,
  onToggle,
  onToggleAll,
  drag,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  templates: Template[];
  loading: boolean;
  checkedIds: Set<number>;
  onToggle: (id: number) => void;
  onToggleAll: (on: boolean) => void;
  drag: ReturnType<typeof useRowDrag<number>>;
  onOpen: (t: Template) => void;
  onEdit: (t: Template) => void;
  onDuplicate: (t: Template) => void;
  onDelete: (t: Template) => void;
}) {
  const hint = useHint();
  const allChecked =
    templates.length > 0 && templates.every((t) => checkedIds.has(t.id));
  const someChecked = !allChecked && templates.some((t) => checkedIds.has(t.id));
  return (
    <div className="min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:overflow-visible">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-16 text-center">
              <input
                type="checkbox"
                className="accent-primary align-middle"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked;
                }}
                onChange={(e) => onToggleAll(e.target.checked)}
                disabled={loading || templates.length === 0}
                aria-label="Select every template"
                {...hint(
                  "Tick every template, for Multi-template. They open in this list's order; drag a row by its grip to change it",
                )}
              />
            </TableHead>
            <TableHead className="w-10" />
            <TableHead>Name</TableHead>
            <TableHead className="w-24 text-right">Sessions</TableHead>
            <TableHead className="w-48">Startup</TableHead>
            <TableHead className="w-40 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          ) : (
            templates.map((t) => {
              const chip = STARTUP_CHIP[t.startup] ?? null;
              const dropSide = drag.dropSide(t.id);
              return (
                <TableRow
                  key={t.id}
                  {...drag.rowProps(t.id)}
                  data-state={checkedIds.has(t.id) ? "selected" : undefined}
                  onClick={() => onToggle(t.id)}
                  // A double-click is two clicks first, so the tick goes on and
                  // off again and is left as it was.
                  onDoubleClick={() => onOpen(t)}
                  className={cn(
                    "group cursor-pointer",
                    drag.isDragging(t.id) && "opacity-40",
                    // The drop line, drawn on the cells because a table row
                    // does not reliably paint a shadow of its own.
                    dropSide === "before" &&
                      "[&>td]:shadow-[inset_0_2px_0_0_var(--primary)]",
                    dropSide === "after" &&
                      "[&>td]:shadow-[inset_0_-2px_0_0_var(--primary)]",
                  )}
                >
                  <TableCell className="whitespace-nowrap text-center">
                    <input
                      type="checkbox"
                      className="accent-primary align-middle"
                      checked={checkedIds.has(t.id)}
                      onChange={() => onToggle(t.id)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${t.name}`}
                    />
                    <RowGrip
                      gripProps={drag.gripProps(t.id)}
                      hintProps={hint(
                        "Drag to change this template's place in the list. Several ticked templates open in this order",
                      )}
                    />
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "block h-3 w-3 rounded-full border border-border",
                        !t.color && "border-dashed",
                      )}
                      style={t.color ? { backgroundColor: t.color } : undefined}
                      aria-label={t.color || "no colour"}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {t.items.length}
                  </TableCell>
                  <TableCell>
                    {chip && (
                      <span
                        className="rounded bg-muted px-1.5 py-0.5 text-[11px]"
                        {...hint(chip.hint)}
                      >
                        {chip.label}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div
                      className="flex justify-end gap-1"
                      // The buttons are not the row: double-clicking one must
                      // not also open the template.
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(t);
                        }}
                        aria-label={`Open ${t.name}`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        {...hint(
                          `Open every session in "${t.name}", in order, on the Terminals tab. Double-clicking the row does the same`,
                        )}
                      >
                        <PlayIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(t);
                        }}
                        aria-label={`Edit ${t.name}`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        {...hint("Open this template on the Templates tab")}
                      >
                        <PencilIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDuplicate(t);
                        }}
                        aria-label={`Duplicate ${t.name}`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        {...hint(
                          "Save a copy of this template under the next free number, then change the copy with the pencil. The copy does not open at startup.",
                        )}
                      >
                        <CopyIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(t);
                        }}
                        aria-label={`Delete ${t.name}`}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-500"
                        {...hint(
                          "Delete this template. The hosts and shells it names are untouched.",
                        )}
                      >
                        <Trash2Icon className="h-4 w-4" />
                      </button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
