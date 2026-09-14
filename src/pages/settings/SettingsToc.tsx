import { useRef } from "react";
import { SearchIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useHint } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * The panel down the left of Settings: the search box, then every section the
 * search keeps, with the one in view lit.
 *
 * Help's panel, deliberately, so the two long pages in the app are found your
 * way around the same way. The list is what jumps: clicking a name scrolls
 * there and leaves the search as it is, since the list only holds sections the
 * search already kept. The header's Jump to list still exists, but only below
 * the width where this panel hides, which is where Help's search moves too.
 *
 * Its buttons carry no `settings-sec-` ids. That prefix is how index.css finds
 * a section to draw as a card, and how the scroll bookkeeping finds a section
 * at all; a panel entry wearing one would be both.
 */
export function SettingsToc({
  query,
  onQueryChange,
  titles,
  activeTitle,
  onPick,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  /** The sections the search keeps, in page order. */
  titles: readonly string[];
  activeTitle: string | null;
  onPick: (title: string) => void;
}) {
  const hint = useHint();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    // Capped at the window and scrolling inside, so a large app font or a
    // short window cannot push the last sections out of reach below a panel
    // that does not move.
    <div className="sticky top-4 flex max-h-[calc(100vh-4rem)] flex-col gap-3">
      <div className="relative shrink-0">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search sections…"
          aria-label="Search settings sections"
          className="pl-8 pr-8"
          {...hint(
            "Filter the settings sections by what they are about, not only their name: “git” finds Custom terminals",
          )}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            title="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav
        aria-label="Settings sections"
        className="min-h-0 space-y-0.5 overflow-y-auto"
      >
        {titles.map((title) => (
          <button
            key={title}
            type="button"
            onClick={() => onPick(title)}
            aria-current={activeTitle === title ? "true" : undefined}
            className={cn(
              "flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
              activeTitle === title
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </button>
        ))}
        {titles.length === 0 && (
          <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
            No sections match.
          </p>
        )}
      </nav>
    </div>
  );
}
