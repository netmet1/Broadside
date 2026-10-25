import type { ComponentProps } from "react";
import { GripVerticalIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The thumb a table row is dragged by (lib/useRowDrag), drawn to the right of
 * the row's tick on the Hosts tab's three tables.
 *
 * Always visible, faintly, rather than only on hover the way the "+" launcher
 * draws its own: a table is somewhere a list gets arranged, and a handle that
 * only appears under the pointer is one that nobody finds (prompts121 asked for
 * the Profiles grip, which was already there, hidden).
 *
 * The click is stopped here, so pressing the grip never ticks the row.
 */
export function RowGrip({
  gripProps,
  hintProps,
}: {
  /** From `useRowDrag().gripProps(id)`. */
  gripProps: {
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** From `useHint()`, saying what dragging does here. */
  hintProps?: ComponentProps<"span">;
}) {
  return (
    <span
      aria-hidden="true"
      {...gripProps}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex cursor-grab rounded p-0.5 align-middle text-muted-foreground/50 hover:bg-accent hover:text-foreground active:cursor-grabbing",
        "group-hover:text-muted-foreground",
      )}
      {...hintProps}
    >
      <GripVerticalIcon className="h-3.5 w-3.5" />
    </span>
  );
}
