import { useState, type DragEvent } from "react";

export type DropSide = "before" | "after";

/** `ids` with `from` moved to just before or just after `to`. Pure. */
export function moveId<T>(ids: T[], from: T, to: T, side: DropSide): T[] {
  if (from === to) return ids;
  const rest = ids.filter((id) => id !== from);
  const at = rest.indexOf(to);
  if (at === -1) return ids;
  rest.splice(side === "before" ? at : at + 1, 0, from);
  return rest;
}

/**
 * Dragging rows into a new order by a grip: profiles in the Terminals "+"
 * launcher and on the Hosts tab, and the Hosts tab's hosts and templates. One
 * way of moving a list, wherever the list is.
 *
 * **Dragging is by the grip only.** A launcher row is a launch button and a
 * table row toggles its tick, so a whole-row drag would turn a slightly moving
 * click into a drag and a slightly short drag into a click. Pressing the grip
 * arms that one row as draggable, and letting go disarms it. Native drag
 * events, no library (the tab strip's pattern), with the drop line drawn above
 * or below the row under the pointer, so a row can go to the very end.
 *
 * `onReorder` gets the whole order after a drop, as ids. `ids` is the order the
 * move is made in, which need not be the rows on screen: a filtered table
 * passes the whole list, and the dragged row lands beside its target in that.
 */
export function useRowDrag<T extends string | number>(
  ids: T[],
  onReorder: (ids: T[]) => void,
) {
  const [armedId, setArmedId] = useState<T | null>(null);
  const [dragId, setDragId] = useState<T | null>(null);
  const [over, setOver] = useState<{ id: T; side: DropSide } | null>(null);

  const endDrag = () => {
    setArmedId(null);
    setDragId(null);
    setOver(null);
  };

  /** Spread onto the row. */
  const rowProps = (id: T) => ({
    draggable: armedId === id,
    onDragStart: (e: DragEvent) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
      // Some webviews need drag data set or the drag is rejected.
      e.dataTransfer.setData("text/plain", String(id));
    },
    onDragOver: (e: DragEvent) => {
      if (dragId === null || dragId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const box = e.currentTarget.getBoundingClientRect();
      const side: DropSide =
        e.clientY < box.top + box.height / 2 ? "before" : "after";
      if (over?.id !== id || over.side !== side) setOver({ id, side });
    },
    onDrop: (e: DragEvent) => {
      // Only a drop this hook started: a column header dragged over a row is
      // someone else's gesture.
      if (dragId === null) return;
      e.preventDefault();
      if (over && dragId !== over.id) {
        onReorder(moveId(ids, dragId, over.id, over.side));
      }
      endDrag();
    },
    onDragEnd: endDrag,
  });

  /** Spread onto the grip. */
  const gripProps = (id: T) => ({
    onPointerDown: () => setArmedId(id),
    onPointerUp: () => setArmedId(null),
    onPointerCancel: () => setArmedId(null),
  });

  /** Where the drop line goes on this row, or null for none. */
  const dropSide = (id: T): DropSide | null =>
    over?.id === id ? over.side : null;

  return {
    rowProps,
    gripProps,
    dropSide,
    isDragging: (id: T) => dragId === id,
  };
}
