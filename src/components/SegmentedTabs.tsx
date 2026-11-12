import type { LucideIcon } from "lucide-react";

import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";

export type Segment<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
  hint: string;
  disabled?: boolean;
};

/**
 * A row of pressed-or-not buttons in one outlined pill: the switch between the
 * views of one tab (Library's Hosts | Templates | Profiles, the Templates tab's
 * Home | Editor | List). The look the Terminals rail's Tabs | Grid toggle
 * already had, so a switch reads the same wherever it is.
 *
 * Buttons with `aria-pressed` rather than an ARIA tablist: a segment can be a
 * jump to another tab (Library's Templates), which is not a tab panel.
 */
export function SegmentedTabs<T extends string>({
  label,
  value,
  segments,
  onChange,
}: {
  /** What the group is, for a screen reader. */
  label: string;
  /** The pressed one, or null when none is. */
  value: T | null;
  segments: Segment<T>[];
  onChange: (value: T) => void;
}) {
  const hint = useHint();
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-input p-0.5"
    >
      {segments.map((s) => {
        const Icon = s.icon;
        const on = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => onChange(s.value)}
            disabled={s.disabled}
            aria-pressed={on}
            className={cn(
              "flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
              on
                ? "bg-accent text-foreground"
                : "text-muted-foreground not-disabled:hover:text-foreground",
              s.disabled && "opacity-50",
            )}
            {...hint(s.hint)}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
