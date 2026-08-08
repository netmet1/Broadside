import { ListFilterIcon, SearchIcon, XIcon } from "lucide-react";

import { RAIL_UNTAGGED, type RailFilter } from "@/lib/useRailFilter";

/**
 * The filter controls that sit at the top of a broadcast host rail: a ctrl-f
 * style label search box and a tag include/exclude dropdown (mirroring the Hosts
 * table's tag-column filter). Purely presentational: all state lives in the
 * shared {@link RailFilter} the caller passes in. Render only when the rail is
 * expanded; it's hidden when collapsed to dots.
 */
export function RailFilterControls({ f }: { f: RailFilter }) {
  // Destructured rather than read as `f.x` throughout, which is not a style
  // preference. One of the thirteen properties is a ref (`tagMenuRef`), and the
  // React Compiler cannot tell which property a `f.x` read is reaching across
  // the hook boundary, so it treats every one of them as a possible ref read
  // during render: fourteen warnings for a component that touches no ref value
  // at all. Naming the bindings lets it track them separately. The Hosts table
  // takes the same shape out of `useHostTagFilter` this way already.
  const {
    hiddenTags,
    tagOptions,
    hasUntagged,
    tagFilterActive,
    toggleTagFilter,
    setAllTagsVisible,
    labelQuery,
    setLabelQuery,
    tagMenuOpen,
    setTagMenuOpen,
    tagMenuRef,
  } = f;
  return (
    <div className="shrink-0 space-y-1.5 px-3 pb-2">
      {/* Label search, filters the rail like ctrl-f (case-insensitive). */}
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={labelQuery}
          onChange={(e) => setLabelQuery(e.target.value)}
          placeholder="Find by label…"
          aria-label="Find hosts by label"
          spellCheck={false}
          className="w-full rounded-md border border-input bg-background py-1 pl-7 pr-7 text-xs outline-none focus-visible:border-ring"
        />
        {labelQuery && (
          <button
            type="button"
            onClick={() => setLabelQuery("")}
            aria-label="Clear label search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Tag filter, same include/exclude semantics as the Hosts table. */}
      <div ref={tagMenuRef} className="relative">
        <button
          type="button"
          onClick={() => setTagMenuOpen((v) => !v)}
          aria-label="Filter by tag"
          aria-expanded={tagMenuOpen}
          className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
            tagFilterActive
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background text-muted-foreground hover:text-foreground"
          }`}
        >
          <ListFilterIcon className="h-3.5 w-3.5" />
          <span>{tagFilterActive ? "Tags filtered" : "Filter tags"}</span>
        </button>
        {tagMenuOpen && (
          <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-full min-w-52 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            <div className="flex items-center justify-between px-2 py-1 text-[11px] font-normal text-muted-foreground">
              <span>Show tags</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setAllTagsVisible(true)}
                >
                  All
                </button>
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setAllTagsVisible(false)}
                >
                  None
                </button>
              </div>
            </div>
            {tagOptions.length === 0 && !hasUntagged ? (
              <p className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
                No tags yet.
              </p>
            ) : (
              <>
                {tagOptions.map((t) => {
                  const key = t.toLowerCase();
                  return (
                    <label
                      key={key}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={!hiddenTags.has(key)}
                        onChange={() => toggleTagFilter(key)}
                      />
                      <span className="min-w-0 truncate">{t}</span>
                    </label>
                  );
                })}
                {hasUntagged && (
                  <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm font-normal italic text-muted-foreground hover:bg-accent">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={!hiddenTags.has(RAIL_UNTAGGED)}
                      onChange={() => toggleTagFilter(RAIL_UNTAGGED)}
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
