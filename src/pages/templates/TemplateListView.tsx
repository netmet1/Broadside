import type { ReactNode } from "react";
import { LayoutTemplateIcon, PlayIcon, PlusIcon } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useHint, usePageStatus } from "@/lib/status";
import type { Template } from "@/lib/tauri/templates";
import { HELP_TEMPLATES, type HelpSectionId } from "@/pages/help/sections";
import { TemplatesView } from "@/pages/templates/TemplatesView";
import { useTemplateList } from "@/pages/templates/useTemplateList";

/**
 * The Templates tab's List: every saved template, and where they are opened.
 *
 * It lived on the Hosts tab (now Library) until prompts135, beside the list of
 * machines, and was hard to find there. Library's Templates button still
 * leads here. Mounted only while the List is showing, so the list is read
 * fresh each time it is.
 */
export function TemplateListView({
  visible,
  strip,
  onOpenTemplates,
  onEdit,
  onNew,
  onChanged,
  onOpenHelp,
}: {
  visible: boolean;
  /** The Home | Editor | List switch, drawn at the left of this view's bar. */
  strip: ReactNode;
  /** Open every session in these templates, one template after another. */
  onOpenTemplates: (templates: Template[]) => void;
  onEdit: (t: Template) => void;
  onNew: () => void;
  /** A template was deleted, copied or moved here. */
  onChanged: () => void;
  onOpenHelp: (section: HelpSectionId) => void;
}) {
  const hint = useHint();
  const {
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
  } = useTemplateList(onChanged);

  usePageStatus(
    loading
      ? null
      : `Showing ${templates.length} ${
          templates.length === 1 ? "template" : "templates"
        }${checked.length > 0 ? ` · ${checked.length} ticked` : ""}`,
    visible,
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border/50 px-3 py-2">
        {strip}
        <div className="flex shrink-0 gap-2">
          {/* Every ticked template, one after another in the list's order.
              One ticked opens just that one, as its row's play button would;
              two or more always ask first, saying the order. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenTemplates(checked)}
            disabled={checked.length === 0}
            aria-label="Multi-template"
            {...hint(
              checked.length === 0
                ? "Tick templates to open several at once, in the list's order. To open just one, use its play button or double-click its row"
                : checked.length === 1
                  ? `Open every session in "${checked[0].name}", in order, on the Terminals tab`
                  : `Open the ${checked.length} ticked templates one after another, top of the list first`,
            )}
          >
            <PlayIcon />
            Multi-template
            {checked.length > 0 ? ` (${checked.length})` : ""}
          </Button>
          <Button
            size="sm"
            onClick={onNew}
            aria-label="New template"
            {...hint("Start a new template in the editor")}
          >
            <PlusIcon />
            New template
          </Button>
        </div>
      </div>

      {loading || templates.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-4">
        <TemplatesView
          templates={templates}
          loading={loading}
          checkedIds={checkedIds}
          onToggle={toggle}
          onToggleAll={toggleAll}
          drag={drag}
          onOpen={(t) => onOpenTemplates([t])}
          onEdit={onEdit}
          onDuplicate={(t) => void duplicate(t)}
          onDelete={setDeleting}
        />
        </div>
      ) : (
        <EmptyState
          icon={LayoutTemplateIcon}
          title="Templates"
          actionLabel="Create your first template"
          onAction={onNew}
          actionHint="Start a new template in the editor"
          description="A template is a saved arrangement of terminal sessions. Build it once, then open the whole set from here in a single action."
          helpSection={HELP_TEMPLATES}
          onOpenHelp={onOpenHelp}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              The arrangement goes. The hosts, shells and profiles it names are
              not touched, and neither is anything currently open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void runDelete()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
