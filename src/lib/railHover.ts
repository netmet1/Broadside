import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent,
  type RefObject,
} from "react";

/**
 * The two-way tie between a page's output and its selection rail: hovering the
 * output a row produced lights that row, as if the pointer were on it too.
 *
 * It is done by hand on the DOM rather than through React state, which is the
 * surprising part and the reason this file exists. Nothing about what the page
 * renders depends on which row is lit, but a hover held in state would re-render
 * the whole output list on every block the pointer crossed, and MultiTerminal's
 * log holds up to five hundred of them. So this writes one attribute on one
 * element and leaves the tree alone.
 *
 * The rails and the output blocks agree through two data attributes rather than
 * through props: `data-rail-src` on a block says which row produced it, and
 * `data-rail-row` on a row says which one it is. Both are strings, since a host
 * id is a number and a session id is not.
 */

/** What a lit row looks like. Kept in one place rather than repeated on four
 * rails, so they cannot drift apart. Slightly stronger than the plain hover
 * shade, because the pointer is somewhere else on the page when this fires and
 * the eye has to find the row rather than already being on it. */
export const RAIL_LINK_CLASS =
  "data-[linked]:bg-accent/60 data-[linked]:ring-1 data-[linked]:ring-inset data-[linked]:ring-primary/40";

/** Marks a rail row as the one identified by `id`. */
export function railRow(id: string | number): { "data-rail-row": string } {
  return { "data-rail-row": String(id) };
}

/** Marks a block of output as having come from the rail row `id`. A null id
 * (a block whose session has since closed, or one reloaded from before the
 * last restart) marks nothing: there is no row left to light, and lighting a
 * different session on the same machine would be a guess. */
export function railSrc(
  id: string | number | null | undefined,
): { "data-rail-src"?: string } {
  return id == null ? {} : { "data-rail-src": String(id) };
}

/**
 * Takes the page's own root ref rather than handing one back, so the caller
 * writes `ref={rootRef}` with a plain identifier. A hook that returned the ref
 * inside an object would make every render read a property off it, which is the
 * shape the "don't touch refs during render" lint rule is looking for, and it
 * would be right to: nothing should have to reach into a ref to render.
 *
 * @param rootRef the subtree holding both the rail and the output. The lookup
 * is scoped to it so two pages mounted at once (they all stay mounted behind
 * the tab strip) cannot light each other's rails.
 */
export function useRailHoverLink(rootRef: RefObject<HTMLElement | null>) {
  const litRef = useRef<Element[]>([]);
  const currentRef = useRef<string | null>(null);

  const clear = useCallback(() => {
    for (const el of litRef.current) el.removeAttribute("data-linked");
    litRef.current = [];
    currentRef.current = null;
  }, []);

  const light = useCallback(
    (id: string | null) => {
      if (id === currentRef.current) return;
      clear();
      const root = rootRef.current;
      if (id === null || !root) return;
      // More than one row can answer to an id in principle; light them all
      // rather than assume the first is the only one.
      const rows = [
        ...root.querySelectorAll(`[data-rail-row="${CSS.escape(id)}"]`),
      ];
      for (const el of rows) el.setAttribute("data-linked", "");
      litRef.current = rows;
      currentRef.current = id;
    },
    [clear, rootRef],
  );

  // One handler on the scroller rather than one per block: the output is a long
  // list, and mouseover bubbles. Moving into the gap between two blocks lands
  // here with no `data-rail-src` above it, which reads as "nothing", which is
  // right.
  const onMouseOver = useCallback(
    (e: MouseEvent) => {
      const src = (e.target as Element).closest?.("[data-rail-src]");
      light(src?.getAttribute("data-rail-src") ?? null);
    },
    [light],
  );

  // A page left with a row lit (switching tabs mid-hover) must not leave the
  // attribute behind on a rail that stays mounted.
  useEffect(() => clear, [clear]);

  // Spread on the scroller holding the output blocks.
  return { onMouseOver, onMouseLeave: clear };
}
