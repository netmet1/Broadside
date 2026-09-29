import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { errorMessage } from "@/lib/tauri/hosts";
import {
  createTemplate,
  deleteTemplate,
  listTemplates,
  type Template,
} from "@/lib/tauri/templates";

/**
 * The Templates side of the Hosts tab: the list, which one is picked, and the
 * things its rows do (delete, duplicate). Editing is not here: the pencil hands
 * the template to the Templates tab.
 *
 * Its own load rather than a field on the hosts one: the two are independent,
 * and a template read that fails must not cost the page its machines.
 */
export function useTemplateList() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  // Which one Open would open. A radio rather than a checkbox: see
  // hosts/TemplatesView.
  const [selectedId, setSelectedId] = useState<number | null>(null);
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

  const runDelete = useCallback(async () => {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    try {
      await deleteTemplate(target.id);
      setSelectedId((id) => (id === target.id ? null : id));
      reload();
      toast.success(`Deleted "${target.name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [deleting, reload]);

  /** A copy under the same name, which the backend numbers ("Morning check
   * 02"), picked in the list so the pencil opens it next. The copy never opens
   * at startup: only one template can, and a copy taking the setting would
   * quietly take it off the original. */
  const duplicate = useCallback(
    async (source: Template) => {
      try {
        const copy = await createTemplate({
          name: source.name,
          color: source.color,
          items: source.items,
          startup: "off",
        });
        setSelectedId(copy.id);
        reload();
        toast.success(`Duplicated as "${copy.name}"`);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    [reload],
  );

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  return {
    templates,
    loading,
    selectedId,
    setSelectedId,
    selected,
    deleting,
    setDeleting,
    runDelete,
    duplicate,
  };
}
