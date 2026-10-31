import type { HTMLAttributes, ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GripVerticalIcon,
} from "lucide-react";

import { useHint } from "@/lib/status";
import type { DropSide } from "@/lib/useRowDrag";
import { cn } from "@/lib/utils";

/**
 * What a launcher section needs to be dragged into another place in the menu:
 * the props for its outer element and for the grip on its header, and where
 * the drop line goes. Built by the page from one `useRowDrag` over the
 * sections, the same hook the rows inside them use.
 */
export type SectionDrag = {
  rowProps: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  gripProps: HTMLAttributes<HTMLSpanElement>;
  dropSide: DropSide | null;
  dragging: boolean;
};

/** The line a dragged section will land at, drawn on the section's edge. */
export function SectionDropLine({ side }: { side: DropSide | null }) {
  if (!side) return null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
        side === "before" ? "-top-px" : "-bottom-px",
      )}
    />
  );
}

/**
 * A section header in the "+" launcher: a twisty, the section's name, how many
 * things are in it, and whatever buttons that section keeps on its header.
 *
 * The count is on the header rather than inside the section because a rolled-up
 * section has to say what is behind it; "PROFILES" alone gives a closed menu no
 * reason to be opened. The header's own buttons stay visible when the section
 * is rolled up: they are how you add to it, and a section you have hidden
 * because it is long is exactly the one you want to import into.
 */
export function LauncherSectionHeader({
  title,
  count,
  open,
  onToggle,
  hintText,
  gripProps,
  children,
}: {
  title: string;
  /** Null while the list is still loading, so the header does not flash a 0. */
  count: number | null;
  open: boolean;
  onToggle: () => void;
  hintText: string;
  /** The grip that drags the whole section to another place in the menu. */
  gripProps?: HTMLAttributes<HTMLSpanElement>;
  children?: ReactNode;
}) {
  const hint = useHint();
  return (
    <div className="group/header flex shrink-0 items-center justify-between gap-1 py-1 pl-0.5 pr-1.5">
      {gripProps && (
        <span
          aria-hidden="true"
          {...gripProps}
          className="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground opacity-0 group-hover/header:opacity-100 active:cursor-grabbing"
          {...hint(
            "Drag to move this whole section up or down the menu. The order is kept across restarts",
          )}
        >
          <GripVerticalIcon className="h-3.5 w-3.5" />
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        {...hint(hintText)}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-sm px-0.5 py-0.5 text-left hover:bg-accent"
      >
        {open ? (
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {count !== null && count > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {count}
          </span>
        )}
      </button>
      {children && (
        <div className="flex shrink-0 items-center gap-0.5">{children}</div>
      )}
    </div>
  );
}
