import { useCallback, useMemo, useState } from "react";

import type { SearchMode } from "@/components/SearchBar";
import {
  buildMatcher,
  isMatcher,
  matchLine,
  type LineMatch,
  type SearchOptions,
} from "@/lib/search";

/** Search state shared by the Logs tabs: scan a flat list of lines. */
export function useLineSearch(lines: { key: string; text: string }[]) {
  const [mode, setMode] = useState<SearchMode | null>(null);
  const [pattern, setPattern] = useState("");
  const [options, setOptions] = useState<SearchOptions | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const matcherOrError = useMemo(
    () =>
      mode !== null && options !== null ? buildMatcher(pattern, options) : null,
    [mode, pattern, options],
  );
  const matcher = isMatcher(matcherOrError) ? matcherOrError : null;

  const scan = useMemo(() => {
    if (!matcher) return null;
    const perLine = new Map<number, LineMatch[]>();
    const hits: { lineIdx: number; match: LineMatch }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const matches = matchLine(matcher, lines[i].text);
      if (matches.length > 0) {
        perLine.set(i, matches);
        for (const m of matches) hits.push({ lineIdx: i, match: m });
      }
    }
    return { perLine, hits };
  }, [matcher, lines]);

  // Back to the first hit whenever the search itself changes, adjusted during
  // render so the counter never shows the old position against a new pattern.
  const [prevSearch, setPrevSearch] = useState({ pattern, options });
  if (prevSearch.pattern !== pattern || prevSearch.options !== options) {
    setPrevSearch({ pattern, options });
    setActiveIdx(0);
  }

  const navigate = useCallback(
    (dir: 1 | -1) => {
      if (!scan || scan.hits.length === 0) return;
      setActiveIdx((i) => (i + dir + scan.hits.length) % scan.hits.length);
    },
    [scan],
  );

  const close = useCallback(() => {
    setMode(null);
    setPattern("");
    setOptions(null);
    setActiveIdx(0);
  }, []);

  const status = (() => {
    if (matcherOrError && "error" in matcherOrError) {
      return { text: matcherOrError.error, tone: "error" as const };
    }
    if (!scan || !pattern) return { text: "", tone: "normal" as const };
    if (scan.hits.length === 0)
      return { text: "No matches", tone: "normal" as const };
    const base = `${scan.hits.length} ${scan.hits.length === 1 ? "match" : "matches"}`;
    return {
      text:
        mode === "find" ? `${activeIdx + 1}/${scan.hits.length} · ${base}` : base,
      tone: "normal" as const,
    };
  })();

  const activeHit =
    mode === "find" && scan && scan.hits.length > 0
      ? scan.hits[Math.min(activeIdx, scan.hits.length - 1)]
      : null;

  return {
    mode,
    setMode,
    setQuery: (p: string, o: SearchOptions) => {
      setPattern(p);
      setOptions(o);
    },
    pattern,
    scan,
    activeHit,
    navigate,
    close,
    status,
    filterActive: mode === "filter" && matcher !== null && pattern !== "",
    // Find hides nothing (D-015) but dims non-matching rows for contrast.
    findActive: mode === "find" && matcher !== null && pattern !== "",
  };
}
