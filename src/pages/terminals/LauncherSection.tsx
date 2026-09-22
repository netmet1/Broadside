import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * The twisty that rolls a section of the Terminals "+" launcher away.
 *
 * Icon-only, for the one header that is already a control of its own (the
 * "How many" row, which is a label and a number input). Everywhere else the
 * twisty and the section's name are one button; see
 * {@link LauncherSectionHeader}.
 */
export function LauncherTwisty({
  open,
  onToggle,
  label,
  hintText,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  /** What the section is called, for the screen-reader label only. */
  label: string;
  hintText: string;
  className?: string;
}) {
  const hint = useHint();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      {...hint(hintText)}
      className={cn(
        "shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {open ? (
        <ChevronDownIcon className="h-3.5 w-3.5" />
      ) : (
        <ChevronRightIcon className="h-3.5 w-3.5" />
      )}
    </button>
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
  children,
}: {
  title: string;
  /** Null while the list is still loading, so the header does not flash a 0. */
  count: number | null;
  open: boolean;
  onToggle: () => void;
  hintText: string;
  children?: ReactNode;
}) {
  const hint = useHint();
  return (
    <div className="flex items-center justify-between gap-1 px-1.5 py-1">
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
