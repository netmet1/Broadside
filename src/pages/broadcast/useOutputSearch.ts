import { useCallback, useEffect, useMemo, useState } from "react";

import { type SearchMode } from "@/components/SearchBar";
import {
  buildMatcher,
  isMatcher,
  matchLine,
  type LineMatch,
  type SearchOptions,
} from "@/lib/search";
import {
  type FindHit,
  type RunGroup,
  blockKeyOf,
} from "@/pages/broadcast/model";

/** Ctrl+F find / Ctrl+Shift+F filter over the accumulated broadcast output
 * (D-015). Owns the search mode/pattern/options + active-hit cursor, scans all
 * runs for matches, and exposes navigation and a status string. The keyboard
 * entry points are active only while the page is `visible`. */
export function useOutputSearch(runs: RunGroup[], visible: boolean) {
  const [searchMode, setSearchMode] = useState<SearchMode | null>(null);
  const [searchPattern, setSearchPattern] = useState("");
  const [searchOptions, setSearchOptions] = useState<SearchOptions | null>(
    null,
  );
  const [activeHitIdx, setActiveHitIdx] = useState(0);

  // Keyboard entry points (D-015). Only while this page is the visible one —
  // the component stays mounted in the background after navigation.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setSearchMode(e.shiftKey ? "filter" : "find");
        setActiveHitIdx(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const closeSearch = useCallback(() => {
    setSearchMode(null);
    setSearchPattern("");
    setSearchOptions(null);
    setActiveHitIdx(0);
  }, []);

  const matcherOrError = useMemo(
    () =>
      searchMode !== null && searchOptions !== null
        ? buildMatcher(searchPattern, searchOptions)
        : null,
    [searchMode, searchPattern, searchOptions],
  );
  const matcher = isMatcher(matcherOrError) ? matcherOrError : null;

  /** Per-stream line matches for every completed block across all runs, in
   * display order. Keyed by `${runId}:${hostId}:${stream}`. */
  const scan = useMemo(() => {
    if (!matcher) return null;
    const byRef = new Map<string, Map<number, LineMatch[]>>();
    const hits: FindHit[] = [];
    const blocksWithMatches = new Set<string>();
    let total = 0;
    for (const run of runs) {
      for (const block of run.blocks) {
        if (block.result.status !== "completed") continue;
        const key = blockKeyOf(run.runId, block.host_id);
        for (const stream of ["stdout", "stderr"] as const) {
          const text = block.result[stream];
          if (!text) continue;
          const lines = text.split("\n");
          const lineMap = new Map<number, LineMatch[]>();
          for (let i = 0; i < lines.length; i++) {
            const matches = matchLine(matcher, lines[i]);
            if (matches.length > 0) {
              lineMap.set(i, matches);
              blocksWithMatches.add(key);
              total += matches.length;
              for (const m of matches) {
                hits.push({ key, stream, line: i, ...m });
              }
            }
          }
          if (lineMap.size > 0) {
            byRef.set(`${key}:${stream}`, lineMap);
          }
        }
      }
    }
    return { byRef, hits, total, hostCount: blocksWithMatches.size };
  }, [matcher, runs]);

  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (!scan || scan.hits.length === 0) return;
      setActiveHitIdx(
        (idx) => (idx + direction + scan.hits.length) % scan.hits.length,
      );
    },
    [scan],
  );

  useEffect(() => {
    setActiveHitIdx(0);
  }, [searchPattern, searchOptions]);

  const searchStatus = (() => {
    if (matcherOrError && "error" in matcherOrError) {
      return { text: matcherOrError.error, tone: "error" as const };
    }
    if (!scan || searchPattern === "")
      return { text: "", tone: "normal" as const };
    if (scan.total === 0) return { text: "No matches", tone: "normal" as const };
    const base = `${scan.total} ${scan.total === 1 ? "match" : "matches"} in ${scan.hostCount} ${scan.hostCount === 1 ? "block" : "blocks"}`;
    return {
      text:
        searchMode === "find"
          ? `${scan.hits.length === 0 ? 0 : activeHitIdx + 1}/${scan.hits.length} · ${base}`
          : base,
      tone: "normal" as const,
    };
  })();

  const activeHit =
    searchMode === "find" && scan && scan.hits.length > 0
      ? scan.hits[Math.min(activeHitIdx, scan.hits.length - 1)]
      : null;

  const filterActive =
    searchMode === "filter" && matcher !== null && searchPattern !== "";

  return {
    searchMode,
    setSearchMode,
    setSearchPattern,
    setSearchOptions,
    matcher,
    scan,
    navigate,
    closeSearch,
    searchStatus,
    activeHit,
    filterActive,
  };
}
