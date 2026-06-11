/**
 * Shared search model for Find / Filter (D-015).
 *
 * - Plain-text mode is case-insensitive by default; regex mode is
 *   case-sensitive by default (editor norms).
 * - `/pattern/flags` slash syntax parses into regex mode.
 * - Frontend regex runs with budget guards against catastrophic
 *   backtracking; Rust-side scans (future audit log) use the linear-time
 *   `regex` crate and need none.
 */

export type SearchOptions = {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
};

export const DEFAULT_PLAIN_OPTIONS: SearchOptions = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
};

/** A `/pattern/flags` power-user query, or null when not slash syntax. */
export function parseSlashSyntax(
  input: string,
): { pattern: string; caseSensitive: boolean } | null {
  const m = /^\/(.+)\/(i?)$/.exec(input);
  if (!m) return null;
  return { pattern: m[1], caseSensitive: m[2] !== "i" };
}

const MAX_PATTERN_LENGTH = 512;
const MAX_LINE_SCAN_CHARS = 4096;
const MAX_MATCHES_PER_LINE = 200;
const MAX_TOTAL_MATCHES = 5000;
/** Wall-clock budget for one full scan pass (checked between lines). */
const SCAN_BUDGET_MS = 120;

export type Matcher = {
  regex: RegExp;
  options: SearchOptions;
};

/** Builds a global matcher, or null for an empty/invalid pattern. */
export function buildMatcher(
  pattern: string,
  options: SearchOptions,
): Matcher | { error: string } | null {
  if (pattern.length === 0) return null;
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { error: "pattern too long" };
  }
  let source = options.regex
    ? pattern
    : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  try {
    return {
      regex: new RegExp(source, options.caseSensitive ? "g" : "gi"),
      options,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid pattern" };
  }
}

export function isMatcher(
  m: Matcher | { error: string } | null,
): m is Matcher {
  return m !== null && "regex" in m;
}

export type LineMatch = {
  start: number;
  end: number;
};

/** Matches within one line, bounded by the per-line budgets. */
export function matchLine(matcher: Matcher, line: string): LineMatch[] {
  const scanned =
    line.length > MAX_LINE_SCAN_CHARS ? line.slice(0, MAX_LINE_SCAN_CHARS) : line;
  const out: LineMatch[] = [];
  matcher.regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = matcher.regex.exec(scanned)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length >= MAX_MATCHES_PER_LINE) break;
    // Zero-width matches (e.g. /a*/) would loop forever without a bump.
    if (m[0].length === 0) matcher.regex.lastIndex++;
  }
  return out;
}

export type ScanResult<Ref> = {
  /** One entry per matching line, in scan order. */
  hits: { ref: Ref; line: number; matches: LineMatch[] }[];
  totalMatches: number;
  /** True when a budget tripped and results are partial. */
  truncated: boolean;
};

/**
 * Scans multi-line texts identified by `ref` (e.g. a host block + stream).
 * Budgets: wall-clock between texts/lines, total match cap.
 */
export function scanTexts<Ref>(
  matcher: Matcher,
  texts: { ref: Ref; text: string }[],
): ScanResult<Ref> {
  const started = performance.now();
  const result: ScanResult<Ref> = { hits: [], totalMatches: 0, truncated: false };
  for (const { ref, text } of texts) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (
        result.totalMatches >= MAX_TOTAL_MATCHES ||
        performance.now() - started > SCAN_BUDGET_MS
      ) {
        result.truncated = true;
        return result;
      }
      const matches = matchLine(matcher, lines[i]);
      if (matches.length > 0) {
        result.hits.push({ ref, line: i, matches });
        result.totalMatches += matches.length;
      }
    }
  }
  return result;
}
