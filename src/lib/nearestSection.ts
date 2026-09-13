/**
 * Which section a reader is looking at, on a page with a panel of section
 * names down one side: the section whose top edge sits nearest a line just
 * under the page's sticky header.
 *
 * Shared by Help and Settings, whose panels both light the section in view, so
 * the two can never disagree about what "in view" means. Sections that are not
 * in the document (filtered out, or not revealed yet) are skipped.
 */
export function nearestSectionId(
  scroller: Element,
  ids: readonly string[],
  offsetPx: number,
): string | null {
  const anchor = scroller.getBoundingClientRect().top + offsetPx;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const dist = Math.abs(el.getBoundingClientRect().top - anchor);
    if (dist < bestDist) {
      bestDist = dist;
      best = id;
    }
  }
  return best;
}
