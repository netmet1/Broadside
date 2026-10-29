import {
  CopyIcon,
  GripVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import type { Template } from "@/lib/tauri/templates";
import { useHint } from "@/lib/status";
import { useRowDrag } from "@/lib/useRowDrag";
import { cn } from "@/lib/utils";
import { LauncherSectionHeader } from "@/pages/terminals/LauncherSection";

type Props = {
  templates: Template[];
  /** True until the first read lands, so "None yet" never flashes at
   * somebody who has a dozen. */
  loading: boolean;
  onNew: () => void;
  onOpen: (template: Template) => void;
  onEdit: (template: Template) => void;
  onDuplicate: (template: Template) => void;
  /** A lone click on the bin, which deletes nothing and explains the gesture. */
  onDeleteClick: () => void;
  /** The double-click that asks to delete. */
  onDeleteRequest: (template: Template) => void;
  /** The whole order after a drag, as ids. */
  onReorder: (ids: number[]) => void;
  open: boolean;
  onToggle: () => void;
};

/**
 * The Templates section of the Terminals "+" launcher: a header with New, then
 * one row per saved template. Clicking a row opens it, through the same
 * placement question as the Hosts tab's Open. Edit and Duplicate hand the
 * template to the Templates tab, where its unsaved-changes guard applies.
 *
 * Built like the Profiles section beside it (ProfileLauncherList), so the two
 * behave alike: the grip drags, the buttons show on hover, and delete takes a
 * double-click and then a dialog.
 */
export function TemplateLauncherList({
  templates,
  loading,
  onNew,
  onOpen,
  onEdit,
  onDuplicate,
  onDeleteClick,
  onDeleteRequest,
  onReorder,
  open,
  onToggle,
}: Props) {
  const hint = useHint();
  const drag = useRowDrag(
    templates.map((t) => t.id),
    onReorder,
  );

  const headerButton =
    "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
  const rowButton =
    "shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100";

  const showsRows = open && !loading && templates.length > 0;
  return (
    // A flex item of the menu's column, like the Profiles section: it gives up
    // height down to its header and one row, and the list below scrolls.
    <div
      className={cn(
        "mt-1 flex flex-col border-t border-border/60 pt-1",
        showsRows && "min-h-[4.75rem]",
      )}
    >
      <LauncherSectionHeader
        title="Templates"
        count={loading ? null : templates.length}
        open={open}
        onToggle={onToggle}
        hintText={
          open
            ? "Roll the template list away. It stays rolled up until you open it again, restarts included"
            : "Show the saved templates"
        }
      >
        <button
          type="button"
          onClick={onNew}
          className={headerButton}
          {...hint("Build a new template on the Templates tab")}
        >
          <PlusIcon className="h-3.5 w-3.5" /> New
        </button>
      </LauncherSectionHeader>
      {!open ? null : loading ? null : templates.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          None yet. A template opens a set of hosts and shells together.
        </p>
      ) : (
        <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain">
          {templates.map((t) => {
            const side = drag.dropSide(t.id);
            return (
              <div
                key={t.id}
                {...drag.rowProps(t.id)}
                className={cn(
                  "group relative flex items-center gap-1 rounded-sm py-1.5 pl-0.5 pr-2 text-sm hover:bg-accent hover:text-accent-foreground",
                  drag.isDragging(t.id) && "opacity-40",
                )}
              >
                {side && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
                      side === "before" ? "-top-px" : "-bottom-px",
                    )}
                  />
                )}
                <span
                  aria-hidden="true"
                  {...drag.gripProps(t.id)}
                  className="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 active:cursor-grabbing"
                  {...hint("Drag to change this template's place in the list")}
                >
                  <GripVerticalIcon className="h-3.5 w-3.5" />
                </span>
                <button
                  type="button"
                  onClick={() => onOpen(t)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={`Open the ${t.items.length} session${t.items.length === 1 ? "" : "s"} in "${t.name}"`}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "block h-2.5 w-2.5 shrink-0 rounded-full border border-border",
                      !t.color && "border-dashed",
                    )}
                    style={t.color ? { backgroundColor: t.color } : undefined}
                  />
                  <span className="truncate">{t.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t.items.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onEdit(t)}
                  aria-label={`Edit ${t.name}`}
                  title="Edit on the Templates tab"
                  className={cn(rowButton, "hover:text-foreground")}
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onDuplicate(t)}
                  aria-label={`Duplicate ${t.name}`}
                  title="Copy into the Templates tab, to change and save"
                  className={cn(rowButton, "hover:text-foreground")}
                >
                  <CopyIcon className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    // The second click of a double-click carries detail 2;
                    // only a click on its own needs explaining.
                    if (e.detail > 1) return;
                    onDeleteClick();
                  }}
                  onDoubleClick={() => onDeleteRequest(t)}
                  aria-label={`Delete ${t.name}`}
                  title="Double-click to delete"
                  className={cn(rowButton, "hover:text-red-500")}
                >
                  <Trash2Icon className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
