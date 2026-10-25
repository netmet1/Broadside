import { useEffect, useMemo, useState } from "react";

import { listTemplates, type Template } from "@/lib/tauri/templates";
import {
  matchesATemplate,
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
 * The templates are read again on every visit to the tab. A template is saved
 * on another tab, so arriving back here is the moment the answer can change.
 */
export function useGridTemplate({
  visible,
  gridMode,
  sessions,
  isLaidOut,
}: {
  visible: boolean;
  gridMode: boolean;
  /** Every tab, in the tab strip's order, which is the grid's. */
  sessions: TermSession[];
  /** Whether this session is a tile in the grid right now. */
  isLaidOut: (s: TermSession) => boolean;
}) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
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
  }, [visible]);

  const tiles = useMemo(
    () => (gridMode ? sessions.filter(isLaidOut) : []),
    [gridMode, sessions, isLaidOut],
  );
  const items = useMemo(
    () => tiles.flatMap((s) => sessionTemplateItem(s) ?? []),
    [tiles],
  );
  const offered =
    templates !== null &&
    items.length >= 2 &&
    !matchesATemplate(items, templates);

  return { offered, items };
}
