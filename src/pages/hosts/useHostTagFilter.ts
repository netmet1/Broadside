import { useEffect, useMemo, useRef, useState } from "react";

import { type Host } from "@/lib/tauri/hosts";
import { allTags, parseTags } from "@/lib/hostTags";
import { TAG_FILTER_KEY, UNTAGGED_KEY } from "@/pages/hosts/constants";

/** Tag filter (#8) for the hosts table: the set of UNCHECKED tags (lowercase)
 * plus UNTAGGED_KEY for no-tag hosts. Empty = everything shown; persists for the
 * session only. Also owns the header dropdown's open state + outside-click. */
export function useHostTagFilter(hosts: Host[], sortedHosts: Host[]) {
  const [hiddenTags, setHiddenTags] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(sessionStorage.getItem(TAG_FILTER_KEY) ?? "[]");
      if (Array.isArray(raw)) {
        return new Set(raw.filter((x) => typeof x === "string"));
      }
    } catch {
      // Fall through to an empty set (no filtering).
    }
    return new Set();
  });
  useEffect(() => {
    sessionStorage.setItem(TAG_FILTER_KEY, JSON.stringify([...hiddenTags]));
  }, [hiddenTags]);

  // Every distinct tag in use (for the dropdown) + whether any host is untagged.
  const tagOptions = useMemo(() => allTags(hosts.map((h) => h.tag)), [hosts]);
  const hasUntagged = useMemo(
    () => hosts.some((h) => parseTags(h.tag).length === 0),
    [hosts],
  );
  const tagFilterActive = hiddenTags.size > 0;
  const toggleTagFilter = (key: string) =>
    setHiddenTags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const setAllTagsVisible = (visible: boolean) =>
    setHiddenTags(
      visible
        ? new Set()
        : new Set([
            ...tagOptions.map((t) => t.toLowerCase()),
            ...(hasUntagged ? [UNTAGGED_KEY] : []),
          ]),
    );

  // Apply the tag filter (OR semantics): a host shows if any of its tags is
  // still checked; an untagged host shows unless "(untagged)" is unchecked.
  const visibleHosts = useMemo(() => {
    if (hiddenTags.size === 0) return sortedHosts;
    return sortedHosts.filter((h) => {
      const tags = parseTags(h.tag);
      if (tags.length === 0) return !hiddenTags.has(UNTAGGED_KEY);
      return tags.some((t) => !hiddenTags.has(t.toLowerCase()));
    });
  }, [sortedHosts, hiddenTags]);

  // Self-contained tag-filter dropdown, opened from the Tag header icon.
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tagMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!tagMenuRef.current?.contains(e.target as Node)) setTagMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTagMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [tagMenuOpen]);

  return {
    hiddenTags,
    tagOptions,
    hasUntagged,
    tagFilterActive,
    toggleTagFilter,
    setAllTagsVisible,
    visibleHosts,
    tagMenuOpen,
    setTagMenuOpen,
    tagMenuRef,
  };
}
