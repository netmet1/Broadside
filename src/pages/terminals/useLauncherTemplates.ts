import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  deleteTemplate as deleteTemplateRow,
  listTemplates,
  reorderTemplates,
  type Template,
} from "@/lib/tauri/templates";

/**
 * The Templates section of the Terminals "+" launcher: the list, its order and
 * delete. Opening, editing and duplicating are not here; they hand the
 * template to App, which owns the placement question and the Templates tab.
 *
 * Read every time the menu opens, like the launcher's hosts: templates are
 * built on another tab, this page stays mounted for the life of the app, and a
 * list fixed at startup would be missing the one saved a minute ago. Its own
 * copy rather than one shared with the Hosts tab's list, the same bargain as
 * the profile lists (see lib/useProfileActions): every write ends in a re-read,
 * and both lists re-read when they are shown.
 */
export function useLauncherTemplates(menuOpen: boolean) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    listTemplates()
      .then(setTemplates)
      .catch((e) => toast.error(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    let alive = true;
    listTemplates()
      .then((list) => {
        if (alive) setTemplates(list);
      })
      .catch((e) => {
        // The section shows what it had; the rest of the menu is unaffected.
        if (alive) toast.error(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [menuOpen]);

  /** The list after a drag. Shown at once and saved behind it; a failed save
   * says so and puts the stored order back. */
  const reorder = useCallback(
    (ids: number[]) => {
      setTemplates((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t] as const));
        const moved = ids.flatMap((id) => byId.get(id) ?? []);
        return [...moved, ...prev.filter((t) => !ids.includes(t.id))];
      });
      reorderTemplates(ids).catch((e: unknown) => {
        toast.error(errorMessage(e));
        reload();
      });
    },
    [reload],
  );

  const remove = useCallback(
    async (target: Template) => {
      try {
        await deleteTemplateRow(target.id);
        toast.success(`Deleted "${target.name}"`);
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        reload();
      }
    },
    [reload],
  );

  return { templates, loading, reorder, remove };
}
