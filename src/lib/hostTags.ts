/** Hosts store their tags as a single comma-separated string (e.g.
 * "prod, web, eu") in the `tag` column — no schema change from the single-tag
 * model. These helpers parse that field into a normalized list and back, so the
 * table, sort, and filter all agree on what "the tags" are. */

/** Split a host's `tag` field into trimmed, non-empty tags. Order is preserved;
 * duplicates (case-insensitive) are dropped, keeping the first spelling. */
export function parseTags(tag: string | null | undefined): string[] {
  if (!tag) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of tag.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** The first tag, lowercased, for sort ordering — or "" when untagged. */
export function firstTag(tag: string | null | undefined): string {
  return parseTags(tag)[0]?.toLowerCase() ?? "";
}

/** The de-duplicated union of every tag across the given `tag` fields, sorted
 * A-Z (case-insensitive), in their first-seen display spelling. */
export function allTags(tagFields: (string | null | undefined)[]): string[] {
  const map = new Map<string, string>(); // lowercase key -> display form
  for (const field of tagFields) {
    for (const tag of parseTags(field)) {
      const key = tag.toLowerCase();
      if (!map.has(key)) map.set(key, tag);
    }
  }
  return [...map.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}
