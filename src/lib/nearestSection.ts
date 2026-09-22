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

/**
 * The section the reader is *inside*: the last one whose top edge has reached
 * the line under the sticky header.
 *
 * Help uses this rather than `nearestSectionId`, because Help lists the section
 * in view's sub-headers under it. Nearest-edge changes its answer halfway
 * through a long section (the next heading being closer than the one far
 * above), which lit the neighbour and would list the neighbour's sub-headers
 * beside the text of this one. At the very bottom of the page, where a short
 * last section can never reach the line, it falls back to nearest, so a click
 * on that section still lights it.
 */
export function containingSectionId(
  scroller: Element,
  ids: readonly string[],
  offsetPx: number,
): string | null {
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
    return nearestSectionId(scroller, ids, offsetPx);
  }
  const anchor = scroller.getBoundingClientRect().top + offsetPx;
  let first: string | null = null;
  let inside: string | null = null;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    first ??= id;
    // A couple of pixels of slack: a smooth scroll to a heading can settle a
    // fraction short of the line.
    if (el.getBoundingClientRect().top <= anchor + 2) inside = id;
  }
  return inside ?? first;
}
