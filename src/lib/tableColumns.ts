/**
 * Column preferences for a table the user can rearrange: which of its columns
 * are hidden and what order the movable ones are in, both in localStorage.
 *
 * Two tables have them, the Hosts table and the Profiles table beside it on the
 * Hosts tab, and they want exactly the same rules, so the rules are written
 * once here and each table names its own keys (see ./hostColumns and
 * ./profileColumns).
 */

export type ColumnDef = { readonly id: string; readonly label: string };

export type ColumnPrefsConfig = {
  /** localStorage key for the hidden set. */
  hiddenKey: string;
  /** localStorage key for the order. */
  orderKey: string;
  /** Fired on this window whenever either is written, so Settings and an
   * already-open table stay in step. The browser's own `storage` event only
   * reaches other documents, so it is no use inside one. */
  event: string;
  /** The movable columns, in the order they ship in. */
  orderable: readonly ColumnDef[];
};

export type ColumnPrefs = {
  event: string;
  loadHidden: () => Set<string>;
  saveHidden: (hidden: Set<string>) => void;
  loadOrder: () => string[];
  saveOrder: (order: string[]) => void;
  /** Every column shown, in the shipped order. Widths are left alone: they are
   * dragged on the table itself, not set where the reset button is. */
  reset: () => void;
};

/** Move `dragged` to sit where `target` is. Returns the new order. */
export function reorderColumns(
  order: string[],
  dragged: string,
  target: string,
): string[] {
  if (dragged === target) return order;
  const next = order.filter((id) => id !== dragged);
  const at = next.indexOf(target);
  if (at < 0) return order;
  // In front of the target when moving left, behind it when moving right,
  // which is what "drop it here" means in each direction: dragging a column
  // rightwards past another is a request to end up on the far side of it.
  const movingRight = order.indexOf(dragged) < order.indexOf(target);
  next.splice(movingRight ? at + 1 : at, 0, dragged);
  return next;
}

export function columnPrefs(config: ColumnPrefsConfig): ColumnPrefs {
  const announce = () => window.dispatchEvent(new Event(config.event));
  const readArray = (key: string): string[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(raw)) return raw.filter((x) => typeof x === "string");
    } catch {
      // Fall through to nothing stored.
    }
    return [];
  };
  const write = (key: string, value: string[]) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage refused (private window, full): the choice lasts this visit.
    }
    announce();
  };

  return {
    event: config.event,
    loadHidden: () => new Set(readArray(config.hiddenKey)),
    saveHidden: (hidden) => write(config.hiddenKey, [...hidden]),
    /** The saved order, repaired against what ships.
     *
     * Anything stored that is no longer a column is dropped, and any column the
     * saved order has never heard of is appended in its shipped position. That
     * way a column added in a later version turns up in everyone's table
     * instead of quietly never rendering, which is the failure mode a bare
     * stored array has. */
    loadOrder: () => {
      const shipped = config.orderable.map((c) => c.id);
      const kept = readArray(config.orderKey).filter((id) => shipped.includes(id));
      const missing = shipped.filter((id) => !kept.includes(id));
      return [...kept, ...missing];
    },
    saveOrder: (order) => write(config.orderKey, order),
    reset: () => {
      try {
        localStorage.removeItem(config.hiddenKey);
        localStorage.removeItem(config.orderKey);
      } catch {
        // Nothing stored to remove.
      }
      announce();
    },
  };
}
