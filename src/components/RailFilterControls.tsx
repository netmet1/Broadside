import { ListFilterIcon, SearchIcon, XIcon } from "lucide-react";

import { RAIL_UNTAGGED, type RailFilter } from "@/lib/useRailFilter";

/**
 * The filter controls that sit at the top of a broadcast host rail: a ctrl-f
 * style label search box and a tag include/exclude dropdown (mirroring the Hosts
 * table's tag-column filter). Purely presentational — all state lives in the
 * shared {@link RailFilter} the caller passes in. Render only when the rail is
 * expanded; it's hidden when collapsed to dots.
 */
export function RailFilterControls({ f }: { f: RailFilter }) {
  return (
    <div className="shrink-0 space-y-1.5 px-3 pb-2">
      {/* Label search — filters the rail like ctrl-f (case-insensitive). */}
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={f.labelQuery}
          onChange={(e) => f.setLabelQuery(e.target.value)}
          placeholder="Find by label…"
          aria-label="Find hosts by label"
          spellCheck={false}
          className="w-full rounded-md border border-input bg-background py-1 pl-7 pr-7 text-xs outline-none focus-visible:border-ring"
        />
        {f.labelQuery && (
          <button
            type="button"
            onClick={() => f.setLabelQuery("")}
            aria-label="Clear label search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Tag filter — same include/exclude semantics as the Hosts table. */}
      <div ref={f.tagMenuRef} className="relative">
        <button
          type="button"
          onClick={() => f.setTagMenuOpen((v) => !v)}
          aria-label="Filter by tag"
          aria-expanded={f.tagMenuOpen}
          className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
            f.tagFilterActive
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background text-muted-foreground hover:text-foreground"
          }`}
        >
          <ListFilterIcon className="h-3.5 w-3.5" />
          <span>{f.tagFilterActive ? "Tags filtered" : "Filter tags"}</span>
        </button>
        {f.tagMenuOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-full min-w-52 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            <div className="flex items-center justify-between px-2 py-1 text-[11px] font-normal text-muted-foreground">
              <span>Show tags</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => f.setAllTagsVisible(true)}
                >
                  All
                </button>
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => f.setAllTagsVisible(false)}
                >
                  None
                </button>
              </div>
            </div>
            {f.tagOptions.length === 0 && !f.hasUntagged ? (
              <p className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
                No tags yet.
              </p>
            ) : (
              <>
                {f.tagOptions.map((t) => {
                  const key = t.toLowerCase();
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={!f.hiddenTags.has(key)}
                        onChange={() => f.toggleTagFilter(key)}
                      />
                      <span className="min-w-0 truncate">{t}</span>
                    </label>
                  );
                })}
                {f.hasUntagged && (
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal italic text-muted-foreground hover:bg-accent">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={!f.hiddenTags.has(RAIL_UNTAGGED)}
                      onChange={() => f.toggleTagFilter(RAIL_UNTAGGED)}
                    />
                    <span>(untagged)</span>
                  </label>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
