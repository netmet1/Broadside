import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  reorderTemplates,
  type Template,
} from "@/lib/tauri/templates";
import { useRowDrag } from "@/lib/useRowDrag";

/**
 * The Templates side of the Hosts tab: the list, which ones are ticked, and the
 * things its rows do (delete, duplicate, drag). Editing is not here: the pencil
 * hands the template to the Templates tab.
 *
 * Its own load rather than a field on the hosts one: the two are independent,
 * and a template read that fails must not cost the page its machines.
 */
export function useTemplateList() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  // Which ones Multi-template would open. Checkboxes, like the hosts beside
  // them: several ticked open one after another, in the list's order.
  const [checkedIds, setCheckedIds] = useState<Set<number>>(() => new Set());
  const [deleting, setDeleting] = useState<Template | null>(null);

  const reload = useCallback(() => {
    listTemplates()
      .then(setTemplates)
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let alive = true;
    listTemplates()
      .then((list) => {
        if (alive) setTemplates(list);
      })
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback((id: number) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (on: boolean) =>
      setCheckedIds(on ? new Set(templates.map((t) => t.id)) : new Set()),
    [templates],
  );

  const runDelete = useCallback(async () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    try {
      await deleteTemplate(target.id);
      setCheckedIds((prev) => {
        if (!prev.has(target.id)) return prev;
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
      reload();
      toast.success(`Deleted "${target.name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [deleting, reload]);

  /** A copy under the same name, which the backend numbers ("Morning check
   * 02"), placed directly under its source. The copy never opens at startup:
   * only one template can, and a copy taking the setting would quietly take it
   * off the original. */
  const duplicate = useCallback(
    async (source: Template) => {
      try {
        const copy = await createTemplate(
          {
            name: source.name,
            color: source.color,
            items: source.items,
            startup: "off",
          },
          source.id,
        );
        reload();
        toast.success(`Duplicated as "${copy.name}"`);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    [reload],
  );

  // The grip beside each tick. Saved straight away and drawn straight away; a
  // save that fails says so and reads the list back as it really is.
  const onReorder = useCallback(
    (ids: number[]) => {
      setTemplates((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t] as const));
        return ids.flatMap((id) => byId.get(id) ?? []);
      });
      reorderTemplates(ids).catch((e) => {
        toast.error(errorMessage(e));
        reload();
      });
    },
    [reload],
  );
  const drag = useRowDrag(
    templates.map((t) => t.id),
    onReorder,
  );

  /** The ticked ones, in the list's order, which is the order they open in.
   * A tick on a template deleted elsewhere simply has nothing to point at. */
  const checked = useMemo(
    () => templates.filter((t) => checkedIds.has(t.id)),
    [templates, checkedIds],
  );

  return {
    templates,
    loading,
    checkedIds,
    checked,
    toggle,
    toggleAll,
    deleting,
    setDeleting,
    runDelete,
    duplicate,
    drag,
  };
}
