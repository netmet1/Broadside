import { type ComponentProps } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
} from "lucide-react";

import { type SortKey } from "@/pages/hosts/constants";

/** A clickable column header that toggles sorting on `sortKey` and shows the
 * current direction. */
export function SortHeader({
  label,
  display,
  sortKey,
  sort,
  onSort,
  headHint,
}: {
  label: string;
  /** Visible header text when it should differ from the accessible label —
   * e.g. the narrow Status column shows just "S" but stays "Status" for
   * screen readers and the sort aria-label. */
  display?: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" } | null;
  onSort: (key: SortKey) => void;
  /** Status-bar help props (from useHint) — explains the column on hover. */
  headHint?: ComponentProps<"button">;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active
    ? ChevronsUpDownIcon
    : sort!.dir === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className="-mx-1 flex min-w-0 max-w-full items-center gap-2 rounded px-1 py-0.5 hover:text-foreground"
      aria-label={`Sort by ${label}`}
      {...headHint}
    >
      <span className="truncate">{display ?? label}</span>
      <Icon
        className={`h-3 w-3 shrink-0 ${active ? "text-foreground" : "text-muted-foreground/50"}`}
      />
    </button>
  );
}
