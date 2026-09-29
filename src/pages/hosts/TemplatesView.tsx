import { CopyIcon, PencilIcon, Trash2Icon } from "lucide-react";

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
 * The Templates side of the Hosts tab: the list, and the one action that opens
 * one.
 *
 * The radio is not decoration. A template opens a whole arrangement, and
 * opening two of them at once is not a thing anybody means to do: checkboxes
 * would say it was, and would then need a rule about what happens when you tick
 * three. One at a time, said by the control itself.
 */
export function TemplatesView({
  templates,
  loading,
  selectedId,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  templates: Template[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onEdit: (t: Template) => void;
  onDuplicate: (t: Template) => void;
  onDelete: (t: Template) => void;
}) {
  const hint = useHint();
  return (
    <div className="min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:overflow-visible">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            <TableHead className="w-10 text-center" {...hint("Pick the one to open")} />
            <TableHead className="w-10" />
            <TableHead>Name</TableHead>
            <TableHead className="w-24 text-right">Sessions</TableHead>
            <TableHead className="w-48">Startup</TableHead>
            <TableHead className="w-32 text-right">Actions</TableHead>
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
              return (
                <TableRow
                  key={t.id}
                  data-state={selectedId === t.id ? "selected" : undefined}
                  onClick={() => onSelect(t.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="text-center">
                    <input
                      type="radio"
                      name="template-to-open"
                      className="accent-primary align-middle"
                      checked={selectedId === t.id}
                      onChange={() => onSelect(t.id)}
                      aria-label={`Select ${t.name}`}
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
                    <div className="flex justify-end gap-1">
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
