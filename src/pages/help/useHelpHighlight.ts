/**
 * Marking what you searched for, inside the section the search kept.
 *
 * The Help filter matches a section's title and its keyword blob, so a search
 * for `ctrl shift g` correctly leaves you looking at **Terminals** — and then
 * you are on your own, scrolling a long section hunting for the sentence that
 * earned the match. (The report was someone reaching for Ctrl+F to search the
 * page they had just searched.) This puts a mark on the words themselves and
 * takes you to the first one.
 *
 * Done with the CSS Custom Highlight API rather than by wrapping matches in
 * `<mark>` elements: the section bodies are JSX that React owns, and injecting
 * elements into them behind React's back is the kind of thing that works until
 * the day it doesn't. A `Highlight` is a set of `Range`s held outside the DOM
 * and painted by the browser, so nothing in the tree is touched at all. Where
 * the API is missing the hook simply finds nothing, and Help behaves as before.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const HIGHLIGHT_NAME = "help-search";

/**
 * The colour a match is painted in, installed the first time it is needed.
 *
 * In a stylesheet this would be four lines in `index.css`, and it was — but
 * `::highlight()` is newer than the CSS parser the production build runs
 * through, which passes the rule along and warns about it on every build. A
 * rule added at runtime skips that parser entirely, and it belongs here anyway:
 * the same support check gates the style and the highlighting itself, so
 * neither exists without the other.
 *
 * Amber because it is the one accent the app does not already spend on status:
 * emerald and red mean connected and failed, sky means a named control, and a
 * search result means none of those. The 40% alpha reads on both themes and
 * leaves the text its own colour.
 */
function ensureHighlightStyle(): void {
  const id = "help-search-highlight-style";
  if (document.getElementById(id)) return;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: #fbbf2466; color: inherit; }`;
  document.head.appendChild(style);
}

/** Below this, a term matches so much of the page that marking it is noise.
 * Two characters is enough for `mc`, `vi`, `ls`. */
const MIN_TERM_LEN = 2;

/** Characters that sit between the words of a shortcut or a filename and that a
 * search is not expected to type: `ctrl shift g` has to find `Ctrl+Shift+G`,
 * and `reset display` has to find `Reset display`. */
const SEPARATORS = String.raw`[\s+._/\\-]*`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pattern for a query. Words are joined by "any run of separators", so the
 * spaces someone types stand in for the punctuation the app actually writes.
 * Returns `null` for a query with nothing long enough to be worth marking.
 *
 * Exported because the filter that decides which sections to keep has to agree
 * with the marks painted inside them: a search that keeps a section and then
 * highlights nothing in it is fine, but the reverse would be a section quietly
 * dropped while holding the words asked for.
 *
 * `flags` is `"gi"` for a scan that walks every match and `"i"` for a plain
 * yes/no test — a `g` pattern carries `lastIndex` between calls and would skip
 * every other section. `floor` is the shortest single term worth matching, and
 * the filter sets it to 1: keeping a section is cheap, painting the page amber
 * is not.
 */
export function queryPattern(
  query: string,
  { flags = "gi", floor = MIN_TERM_LEN }: { flags?: string; floor?: number } = {},
): RegExp | null {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map(escapeRegExp);
  if (terms.length === 0) return null;
  // A single term still has to clear the length floor; a phrase does not, since
  // `ctrl shift g` is specific enough as a whole even though `g` is not.
  if (terms.length === 1 && terms[0]!.length < floor) return null;
  return new RegExp(terms.join(SEPARATORS), flags);
}

/** No query, no marks: one shared empty map, so a render with nothing searched
 * hands back the same object every time. */
const NO_MARKS: ReadonlyMap<string, number> = new Map();

/** Which section a range landed in, counted per section id.
 *
 * Only [`Section`](../HelpPage.tsx) renders a `<section>`, and it puts the
 * section's id on it, so the nearest one above a marked word names the section
 * the reader is looking at. A range with no section above it (nothing in Help
 * is built that way today) is left out rather than guessed at. */
function countBySection(ranges: Range[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const range of ranges) {
    const id = range.startContainer.parentElement?.closest("section[id]")?.id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Every match of `pattern` in the text under `root`, as ranges. */
function findRanges(root: HTMLElement, pattern: RegExp): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.nodeValue ?? "";
    if (text.trim() !== "") {
      // Each node gets its own scan from zero; `lastIndex` is shared state on
      // the RegExp and would otherwise carry over between nodes.
      pattern.lastIndex = 0;
      let m = pattern.exec(text);
      while (m) {
        if (m[0].length > 0) {
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          ranges.push(range);
        } else {
          pattern.lastIndex += 1;
        }
        m = pattern.exec(text);
      }
    }
    node = walker.nextNode();
  }
  return ranges;
}

/** Whether this browser can paint highlights. WebView2 can; the guard is for
 * the type system and for anything older. */
function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS;
}

export type HelpHighlight = {
  /** How many matches are on screen. Zero means the query matched a section's
   * keywords but none of its visible words — a real and unremarkable case. */
  count: number;
  /** Which match is current, 0-based. */
  index: number;
  /** How many of those matches are in each section, by DOM id. A section the
   * filter kept that is missing from this map holds none of them: it was found
   * by a keyword, a word deliberately not written on the page. The list of
   * sections says so rather than leaving the reader hunting for a mark that was
   * never there. */
  countsById: ReadonlyMap<string, number>;
  /** Scroll to the next / previous match, wrapping at the ends. */
  go: (dir: 1 | -1) => void;
};

/**
 * Highlight `query` inside `rootRef` and scroll the first match into view.
 *
 * `deps` is anything that changes what is rendered (the filtered section list),
 * so the ranges are rebuilt against the DOM that is actually there.
 */
export function useHelpHighlight(
  rootRef: React.RefObject<HTMLElement | null>,
  query: string,
  deps: unknown,
): HelpHighlight {
  const [count, setCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [countsById, setCountsById] =
    useState<ReadonlyMap<string, number>>(NO_MARKS);
  const rangesRef = useRef<Range[]>([]);

  const scrollTo = useCallback((i: number) => {
    const range = rangesRef.current[i];
    if (!range) return;
    // A Range cannot be scrolled to, but the element containing it can. Its
    // start node is a text node, so go up to its parent.
    const el = range.startContainer.parentElement;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  useEffect(() => {
    if (!highlightsSupported()) return;
    CSS.highlights.delete(HIGHLIGHT_NAME);
    rangesRef.current = [];

    const root = rootRef.current;
    const pattern = query.trim() === "" ? null : queryPattern(query);
    if (!root || !pattern) {
      setCount(0);
      setIndex(0);
      setCountsById(NO_MARKS);
      return;
    }

    // After paint: the sections for this query have to be in the DOM before
    // there is anything to find in them.
    const raf = requestAnimationFrame(() => {
      const ranges = findRanges(root, pattern);
      rangesRef.current = ranges;
      setCount(ranges.length);
      setIndex(0);
      setCountsById(ranges.length === 0 ? NO_MARKS : countBySection(ranges));
      if (ranges.length === 0) return;
      ensureHighlightStyle();
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
      scrollTo(0);
    });
    return () => cancelAnimationFrame(raf);
  }, [rootRef, query, deps, scrollTo]);

  // Drop the highlight when Help goes away, or it would be left registered
  // against ranges in a tree that is no longer on screen.
  useEffect(() => {
    return () => {
      if (highlightsSupported()) CSS.highlights.delete(HIGHLIGHT_NAME);
    };
  }, []);

  const go = useCallback(
    (dir: 1 | -1) => {
      const n = rangesRef.current.length;
      if (n === 0) return;
      setIndex((i) => {
        const next = (i + dir + n) % n;
        scrollTo(next);
        return next;
      });
    },
    [scrollTo],
  );

  return { count, index, countsById, go };
}
