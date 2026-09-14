import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  LayoutTemplateIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PALETTE } from "@/lib/palette";
import { useHint } from "@/lib/status";
import type { Template, TemplateStartup } from "@/lib/tauri/templates";
import { cn } from "@/lib/utils";

/** What each startup choice is called, and what it actually does. The wording
 * carries the whole difference between the two "on" settings: one opens tabs,
 * the other opens connections. */
const STARTUP_OPTIONS: {
  value: TemplateStartup;
  label: string;
  hint: string;
}[] = [
  {
    value: "off",
    label: "Don't open at startup",
    hint: "This template only opens when you press Open on the Hosts tab.",
  },
  {
    value: "launch",
    label: "Open the tabs at startup",
    hint: "Broadside starts on Terminals with these tabs made, each on its Reconnect button. Nothing connects until you say so.",
  },
  {
    value: "connect",
    label: "Open and connect at startup",
    hint: "Broadside starts on Terminals, connecting every session in this template before anyone has looked. Saving this asks you to confirm.",
  },
];

/**
 * The editor's own bar: what this template is called, what colour it wears,
 * whether it opens itself when Broadside starts, and the four actions.
 *
 * **The bar is one row and stays one row.** It used to wrap, which at a 1024px
 * window put the four actions on a second line and pushed the canvas down. It
 * is now a container query: under 52rem of bar the three labelled buttons drop
 * their labels and go to icons, which is the 116px that makes the difference,
 * and the name field and the startup menu can give a little more ground before
 * anything scrolls. 52rem is where the labelled row stops fitting, measured
 * rather than guessed: roughly 818px of controls, and a 1024px window with the
 * sidebar in its icon strip leaves the bar 744.
 *
 * Startup is a setting on the template rather than a switch in the Hosts list
 * on purpose. It is a property of the arrangement, it belongs with the name and
 * the colour, and putting it here is what lets the confirmation happen at the
 * moment somebody decided it rather than the moment they were doing something
 * else. Only one template may carry it; choosing it here takes it off whichever
 * one had it, which the backend does in the same transaction as the save.
 */
export function TemplateTopBar({
  templates,
  currentId,
  onPick,
  name,
  onNameChange,
  color,
  onColorChange,
  startup,
  onStartupChange,
  saved,
  dirty,
  saving,
  onSave,
  onCancel,
  onDelete,
  onExport,
  onImport,
}: {
  templates: Template[];
  currentId: number | null;
  /** Load another saved template, or start a new one (`null`). */
  onPick: (id: number | null) => void;
  name: string;
  onNameChange: (v: string) => void;
  color: string;
  onColorChange: (v: string) => void;
  startup: TemplateStartup;
  onStartupChange: (v: TemplateStartup) => void;
  /** This template exists in the database (as opposed to being a new one). */
  saved: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onExport: () => void;
  onImport: () => void;
}) {
  const hint = useHint();
  const startupHint =
    STARTUP_OPTIONS.find((o) => o.value === startup)?.hint ?? "";

  return (
    <div className="@container flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border/50 px-3 py-2">
      {/* Which template this is, and the way to another one.
          Here rather than on the Hosts tab's list alone, because the editor
          opened on its own lands on the last one edited and there would
          otherwise be no way from that to any other without leaving the page.
          It picks what to edit and never opens anything: launching stays on the
          Hosts tab, where the list of machines is. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label="Choose a template to edit"
            {...hint("Switch to another saved template, or start a new one")}
          >
            <LayoutTemplateIcon className="h-3.5 w-3.5" />
            <ChevronDownIcon className="-mr-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownMenuItem onSelect={() => onPick(null)}>
            <PlusIcon />
            New template
          </DropdownMenuItem>
          {templates.length > 0 && <DropdownMenuSeparator />}
          {templates.map((t) => (
            <DropdownMenuItem key={t.id} onSelect={() => onPick(t.id)}>
              <span
                className={cn(
                  "h-2.5 w-2.5 shrink-0 rounded-full border border-border",
                  !t.color && "border-dashed",
                )}
                style={t.color ? { backgroundColor: t.color } : undefined}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              {t.id === currentId && (
                <CheckIcon className="h-3.5 w-3.5 opacity-70" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        type="text"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Template name"
        aria-label="Template name"
        spellCheck={false}
        className="h-8 w-48 min-w-28 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring"
        {...hint("What this arrangement is called in the Hosts tab's list")}
      />

      {/* Colour. A menu rather than a row of swatches, because this bar also
          has to hold a name, a startup setting and four buttons at a 1024px
          window, and twelve squares is the one thing here that can fold. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label="Template colour"
            {...hint("The colour this template wears in the Hosts tab's list")}
          >
            <span
              className={cn(
                "h-3.5 w-3.5 rounded-sm border border-border",
                !color && "border-dashed",
              )}
              style={color ? { backgroundColor: color } : undefined}
              aria-hidden="true"
            />
            <ChevronDownIcon className="-mr-1 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto p-2">
          <div className="grid grid-cols-6 gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onColorChange(c)}
                aria-label={`Pick colour ${c}`}
                {...hint(`Give this template the colour ${c}`)}
                className={cn(
                  "h-6 w-6 rounded-md border-2",
                  color.toLowerCase() === c.toLowerCase()
                    ? "border-foreground"
                    : "border-transparent",
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onColorChange("")}
              {...hint("No colour: the template shows a dashed outline in the list")}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md border-2 px-1.5 text-xs",
                color === "" ? "border-foreground" : "border-transparent",
              )}
            >
              <span
                className="h-3.5 w-3.5 rounded-sm border border-dashed border-border"
                aria-hidden="true"
              />
              None
            </button>
            <span className="relative h-6 w-6 shrink-0">
              <span
                className="block h-full w-full rounded-md border-2 border-dashed border-border"
                style={color ? { backgroundColor: color } : undefined}
                aria-hidden="true"
              />
              <input
                type="color"
                value={color || "#3b82f6"}
                onChange={(e) => onColorChange(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="Pick any colour"
                title="Pick any colour"
                {...hint("Open the system colour picker for anything not in the twelve")}
              />
            </span>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <select
        value={startup}
        onChange={(e) => onStartupChange(e.target.value as TemplateStartup)}
        aria-label="Open this template at startup"
        className="h-8 min-w-24 truncate rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:border-ring"
        {...hint(startupHint)}
      >
        {STARTUP_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onImport}
          aria-label="Import a template"
          {...hint(
            "Read a template file. Hosts it names are matched against this machine's; the ones that don't match arrive as boxes to point at a host.",
          )}
        >
          <UploadIcon className="h-3.5 w-3.5" />
          <span className="@max-[52rem]:hidden">Import</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!saved || dirty}
          onClick={onExport}
          aria-label="Export template"
          {...hint(
            !saved
              ? "Save this template before exporting it: an export is written from what is stored."
              : dirty
                ? "There are unsaved changes. Save first, so the file matches what you see."
                : "Write this template to a file, to import on another machine.",
          )}
        >
          <DownloadIcon className="h-3.5 w-3.5" />
          <span className="@max-[52rem]:hidden">Export</span>
        </Button>
        {saved && (
          <Button
            variant="outline"
            size="sm"
            onClick={onDelete}
            aria-label="Delete template"
            {...hint("Delete this template. The hosts and shells it names are untouched.")}
          >
            <Trash2Icon className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          aria-label="Close the editor"
          {...hint(
            dirty
              ? "Close the editor. Unsaved changes are lost."
              : "Close the editor.",
          )}
        >
          <XIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          disabled={saving || name.trim() === "" || (!dirty && saved)}
          onClick={onSave}
          aria-label={saved ? "Save template" : "Create template"}
          {...hint(
            name.trim() === ""
              ? "A template needs a name before it can be saved."
              : saved
                ? "Save the changes to this template."
                : "Create this template.",
          )}
        >
          <SaveIcon className="h-3.5 w-3.5" />
          <span className="@max-[52rem]:hidden">{saved ? "Save" : "Create"}</span>
        </Button>
      </div>
    </div>
  );
}
