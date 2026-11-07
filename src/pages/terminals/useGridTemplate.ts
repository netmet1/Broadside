import { useCallback, useEffect, useMemo, useState } from "react";

import type { GridSizes } from "@/lib/gridShape";
import { listTemplates, type Template } from "@/lib/tauri/templates";
import {
  layoutFromSizes,
  matchingTemplate,
  sameLayout,
  sessionTemplateItem,
} from "@/pages/terminals/gridTemplate";
import type { TermSession } from "@/pages/terminals/session";

/**
 * Whether the Terminals tab offers to save its grid as a template, and what it
 * would save.
 *
 * Offered only in Grid, only with two or more tiles on screen (one terminal is
 * not an arrangement), and only when no saved template already opens exactly
 * these sessions in this order. Open a template and the button stays away;
 * drag a tile somewhere else, or close one, and it comes back.
 *
 * The tiles counted are the ones laid out: a tab hidden from the grid, or by
 * the Filter, is not part of what is on screen. A serial console has no place
 * in a template and is left out of what is saved, and it does not count
 * towards the two either.
 *
 * When the sessions are a saved template's but the grid's lines have been
 * dragged to sizes that template does not have, the button offers to save the
 * sizes to it instead (`sizesTo`).
 *
 * The templates are read again on every visit to the tab, and after the sizes
 * are saved here (`reload`). A template is saved on another tab, so arriving
 * back here is the moment the answer can change.
 */
export function useGridTemplate({
  visible,
  gridMode,
  sessions,
  isLaidOut,
  sizes,
}: {
  visible: boolean;
  gridMode: boolean;
  /** Every tab, in the tab strip's order, which is the grid's. */
  sessions: TermSession[];
  /** Whether this session is a tile in the grid right now. */
  isLaidOut: (s: TermSession) => boolean;
  /** The grid's own sizes when they are in force, or null for an even split. */
  sizes: GridSizes | null;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [readCount, setReadCount] = useState(0);
  const reload = useCallback(() => setReadCount((n) => n + 1), []);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    listTemplates()
      .then((list) => {
        if (alive) setTemplates(list);
      })
      // Nothing to say: without the list the button simply is not offered,
      // and the Templates tab reports a list it cannot read.
      .catch(() => {
        if (alive) setTemplates(null);
      });
    return () => {
      alive = false;
    };
  }, [visible, readCount]);

  const tiles = useMemo(
    () => (gridMode ? sessions.filter(isLaidOut) : []),
    [gridMode, sessions, isLaidOut],
  );
  const saved = useMemo(
    () =>
      tiles.flatMap((s) => {
        const item = sessionTemplateItem(s);
        return item ? [{ id: s.id, item }] : [];
      }),
    [tiles],
  );
  const items = useMemo(() => saved.map((t) => t.item), [saved]);
  // A width for each tile that is saved, so a serial console left out cannot
  // shift the widths onto the wrong sessions.
  const layout = useMemo(
    () => layoutFromSizes(sizes, saved.map((t) => t.id)),
    [sizes, saved],
  );
  const match =
    templates !== null && items.length >= 2
      ? matchingTemplate(items, templates)
      : null;
  const offered = templates !== null && items.length >= 2 && match === null;
  const sizesTo =
    match !== null &&
    layout !== null &&
    !sameLayout(match.layout, layout, items.length)
      ? match
      : null;

  return { offered, sizesTo, items, layout, reload };
}
