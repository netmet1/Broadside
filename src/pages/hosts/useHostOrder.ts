import { useCallback, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";

import { errorMessage, reorderHosts, type Host } from "@/lib/tauri/hosts";
import { useRowDrag } from "@/lib/useRowDrag";

/**
 * Dragging hosts into the operator's own order, by the grip beside each tick.
 *
 * **The order dragged is the order on screen.** With a column sort on, the
 * table shows the hosts sorted, and dropping a row there saves exactly what the
 * table then shows, with the sort turned off: the list stays where the operator
 * put it rather than jumping to a stored order they could not see. A filtered
 * table (tags, Find by label) drags within the whole list, so the hidden hosts
 * keep their places and the dragged one lands beside its target.
 *
 * Saved straight away and drawn straight away; a save that fails says so and
 * reloads the list as it really is.
 */
export function useHostOrder({
  hosts,
  sortedHosts,
  sorted,
  clearSort,
  setHosts,
  refresh,
}: {
  hosts: Host[];
  /** Every host in the order the table draws them (sorted, not filtered). */
  sortedHosts: Host[];
  /** Whether a column sort is on. */
  sorted: boolean;
  clearSort: () => void;
  setHosts: Dispatch<SetStateAction<Host[]>>;
  refresh: () => Promise<void>;
}) {
  const onReorder = useCallback(
    (ids: number[]) => {
      const byId = new Map(hosts.map((h) => [h.id, h] as const));
      setHosts(ids.flatMap((id) => byId.get(id) ?? []));
      clearSort();
      reorderHosts(ids).catch((e) => {
        toast.error(errorMessage(e));
        void refresh();
      });
    },
    [hosts, setHosts, clearSort, refresh],
  );

  const drag = useRowDrag(
    (sorted ? sortedHosts : hosts).map((h) => h.id),
    onReorder,
  );

  const gripHint = sorted
    ? "Drag to move this host. The list is sorted by a column, so dropping it keeps the order you see as your own and turns the sort off"
    : "Drag to change this host's place in the list. The + menu and the broadcast lists use the same order";

  return { drag, gripHint };
}
