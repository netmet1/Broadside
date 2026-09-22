import { useCallback, useEffect, useState } from "react";

import type { ColumnPrefs } from "@/lib/tableColumns";

/**
 * One table's column prefs as live state: the hidden set and the order, kept in
 * step with every other copy through the prefs' window event, so dragging a
 * column on the table redraws the chips in Settings and the other way round.
 */
export function useColumnPrefs(prefs: ColumnPrefs) {
  const [hiddenCols, setHiddenCols] = useState(prefs.loadHidden);
  const [colOrder, setColOrder] = useState(prefs.loadOrder);

  useEffect(() => {
    const read = () => {
      setColOrder(prefs.loadOrder());
      setHiddenCols(prefs.loadHidden());
    };
    window.addEventListener(prefs.event, read);
    return () => window.removeEventListener(prefs.event, read);
  }, [prefs]);

  /** Show or hide one column, saved at once. */
  const toggleColumn = useCallback(
    (id: string, visible: boolean) => {
      const next = new Set(prefs.loadHidden());
      if (visible) next.delete(id);
      else next.add(id);
      // The save announces itself, and the listener above reads it back.
      prefs.saveHidden(next);
    },
    [prefs],
  );

  return {
    hiddenCols,
    toggleColumn,
    colOrder,
    saveOrder: prefs.saveOrder,
    /** Every column back, in the shipped order, and nothing else touched. */
    resetColumns: prefs.reset,
  };
}
