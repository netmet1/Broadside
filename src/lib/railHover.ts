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
 * The rails and the output blocks agree through data attributes rather than
 * through props: `data-rail-src` on a block says which row produced it, and
 * `data-rail-row` on a row says which one it is. Both are strings, since a host
 * id is a number and a session id is not.
 *
 * Each side carries a **second, weaker identity**: the name the row shows,
 * `data-rail-name` on the row and `data-rail-src-name` on the block. The id is
 * exact and is always tried first. The name is what answers when the id finds
 * nothing, and it is the difference between a log that works and one that only
 * works until you restart: a session id is a live handle, so every block
 * reloaded from the database, and every block from a terminal that has since
 * been closed and opened again, carries an id that can never match anything.
 * Falling back to the name is not the guess it looks like. The rail keeps its
 * names unique itself (that is what the " 02" suffix is for), and the name is
 * the very thing the human is reading off the row.
 */

/** What a lit row looks like. Kept in one place rather than repeated on four
 * rails, so they cannot drift apart. Slightly stronger than the plain hover
 * shade, because the pointer is somewhere else on the page when this fires and
 * the eye has to find the row rather than already being on it. */
export const RAIL_LINK_CLASS =
  "data-[linked]:bg-accent/60 data-[linked]:ring-1 data-[linked]:ring-inset data-[linked]:ring-primary/40";

type RowAttrs = { "data-rail-row": string; "data-rail-name"?: string };
type SrcAttrs = { "data-rail-src"?: string; "data-rail-src-name"?: string };

/** Marks a rail row as the one identified by `id`, and optionally by the name
 * it is showing. Pass the name on any rail whose output outlives its sessions;
 * a rail of hosts (Broadcast) does not need it, because a host id means the
 * same thing next week. */
export function railRow(id: string | number, name?: string | null): RowAttrs {
  return name
    ? { "data-rail-row": String(id), "data-rail-name": name }
    : { "data-rail-row": String(id) };
}

/** Marks a block of output as having come from a rail row: by id while the
 * session behind it is still open, and by the name it is captioned with for
 * ever after. A block with neither marks nothing and lights nothing, which now
 * means only one thing: no row on the rail is that machine any more. */
export function railSrc(
  id: string | number | null | undefined,
  name?: string | null,
): SrcAttrs {
  const attrs: SrcAttrs = {};
  if (id != null) attrs["data-rail-src"] = String(id);
  if (name) attrs["data-rail-src-name"] = name;
  return attrs;
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
    (id: string | null, name: string | null) => {
      // One key for the pair, so crossing two blocks that resolve to the same
      // row does no work. Joined on a newline, which cannot appear in a host
      // label or a session id, so two different pairs cannot collide into one
      // key and leave the wrong row lit.
      const key = id === null && name === null ? null : `${id}\n${name}`;
      if (key === currentRef.current) return;
      clear();
      const root = rootRef.current;
      if (key === null || !root) return;
      // More than one row can answer in principle; light them all rather than
      // assume the first is the only one.
      const find = (attr: string, value: string) => [
        ...root.querySelectorAll(`[${attr}="${CSS.escape(value)}"]`),
      ];
      // Exact identity first. The name is consulted only when the id matched
      // nothing, so while two sessions on one machine are both open they are
      // never confused with each other, which is the whole point of tying this
      // to the session rather than to the host.
      let rows = id ? find("data-rail-row", id) : [];
      if (rows.length === 0 && name) rows = find("data-rail-name", name);
      for (const el of rows) el.setAttribute("data-linked", "");
      litRef.current = rows;
      currentRef.current = key;
    },
    [clear, rootRef],
  );

  // One handler on the scroller rather than one per block: the output is a long
  // list, and mouseover bubbles. Moving into the gap between two blocks lands
  // here with nothing marked above it, which reads as "nothing", which is
  // right.
  const onMouseOver = useCallback(
    (e: MouseEvent) => {
      const src = (e.target as Element).closest?.(
        "[data-rail-src],[data-rail-src-name]",
      );
      light(
        src?.getAttribute("data-rail-src") ?? null,
        src?.getAttribute("data-rail-src-name") ?? null,
      );
    },
    [light],
  );

  // A page left with a row lit (switching tabs mid-hover) must not leave the
  // attribute behind on a rail that stays mounted.
  useEffect(() => clear, [clear]);

  // Spread on the scroller holding the output blocks.
  return { onMouseOver, onMouseLeave: clear };
}
