import { useState } from "react";
import type { DragEvent } from "react";

import { reorderColumns } from "@/lib/hostColumns";

/**
 * Drag-to-reorder over a list of column ids.
 *
 * Shared because the order can be dragged in two places now: the Hosts table's
 * own headers, and the chips in Settings that show what that order currently
 * is. They are the same gesture on the same list, and the awkward half of it
 * (a dragover that must refuse the default, a drop that must not bubble, the
 * highlight clearing on every exit path) is worth writing once.
 *
 * `onReorder` receives the new order; saving it is the caller's business,
 * because the two callers keep it in different places.
 */
export function useColumnDrag(
  order: string[],
  onReorder: (next: string[]) => void,
) {
  /** The column being dragged, and the one the cursor is over. Both null when
   * nothing is being dragged, which is also what hides the drop marker. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  /** Spread onto whatever element carries the column: a header's label, a
   * chip. Deliberately not a component, so each caller keeps its own markup. */
  const dragProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
      // Some targets refuse a drag carrying no data at all.
      e.dataTransfer.setData("text/plain", id);
    },
    onDragEnd: () => {
      setDragId(null);
      setOverId(null);
    },
    onDragOver: (e: DragEvent) => {
      if (!dragId || dragId === id) return;
      // Without this the drop never fires: refusing is the default for a
      // dragover, and a target that never says otherwise never receives one.
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOverId(id);
    },
    onDragLeave: () => setOverId((c) => (c === id ? null : c)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (dragId) onReorder(reorderColumns(order, dragId, id));
      setDragId(null);
      setOverId(null);
    },
  });

  /** Whether this id is the one about to be dropped on, for the highlight. */
  const isTarget = (id: string) => overId === id && dragId !== id;

  return { dragProps, isTarget };
}
