import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { LayoutTemplateIcon } from "lucide-react";
import { toast } from "sonner";

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
import { EmptyState } from "@/components/EmptyState";
import {
  dismissWarning,
  isWarningDismissed,
  type WarningId,
} from "@/lib/dismissedWarnings";
import { useHint, usePageStatus } from "@/lib/status";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  BUSY_TEMPLATE_ITEMS,
  MAX_TEMPLATE_ITEMS,
  createTemplate,
  deleteTemplate,
  exportTemplate,
  listTemplates,
  readTemplateFile,
  updateTemplate,
  type Template,
  type TemplateItem,
  type TemplateStartup,
} from "@/lib/tauri/templates";
import { useRailFilter } from "@/lib/useRailFilter";
import { cn } from "@/lib/utils";
import { HELP_TEMPLATES, type HelpSectionId } from "@/pages/help/sections";
import { TemplateCanvas } from "@/pages/templates/TemplateCanvas";
import { TemplateRail } from "@/pages/templates/TemplateRail";
import { TemplateTopBar } from "@/pages/templates/TemplateTopBar";
import { moveItem } from "@/pages/templates/items";
import { useTemplateSources } from "@/pages/templates/useTemplateSources";

/** Which template the editor was last on, so opening the tab on its own lands
 * where the operator left off rather than on a blank screen. A view preference
 * about this machine, so localStorage rather than a column. */
const LAST_EDITED_KEY = "templates-last-edited";
const SORT_KEY = "templates-rail-sort";

/** How many saved templates the closed-editor screen offers before it stops
 * listing them and points at the Hosts tab instead. The screen is a way back
 * into the editor, not a second copy of the list: past a handful it would grow
 * past the window, and the list that scrolls, sorts and deletes already exists
 * one tab away. */
const SPLASH_RECENT = 5;

/** What the editor is holding: a saved template being changed (`id` set) or one
 * that does not exist yet (`id` null). */
type Draft = {
  id: number | null;
  name: string;
  color: string;
  items: TemplateItem[];
  startup: TemplateStartup;
};

/** A request from the Hosts tab: edit this template, or start a new one
 * (`template: null`). A new one can arrive with its sessions already in it
 * (`items`): the Terminals tab's Save as template, which hands over the grid
 * on screen to be named and saved here.
 *
 * It carries the whole row rather than an id, and a serial number rather than
 * being cleared once acted on. The row, because the Hosts tab has already read
 * the list and a second read here would be a round trip that can fail; the
 * serial, because clearing it would mean the page that consumes the request
 * also has to write state back into the one that made it, and asking twice for
 * the same template would then do nothing the second time.
 */
export type TemplateFocus = {
  template: Template | null;
  items?: TemplateItem[];
  n: number;
};

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  color: "",
  items: [],
  startup: "off",
};

function draftOf(t: Template): Draft {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    items: t.items,
    startup: t.startup,
  };
}

/** What "unsaved" is measured against. The id is left out so a create landing
 * an id does not by itself count as a change. */
function fingerprint(d: Draft): string {
  return JSON.stringify([d.name.trim(), d.color, d.startup, d.items]);
}

/**
 * The Templates tab: where an arrangement of sessions is built, and only that.
 *
 * Nothing is launched from here, which is worth stating because the page looks
 * like it could. A template is opened from the Hosts tab, where the list of
 * them lives beside the list of machines; this is the workshop. Keeping the two
 * apart means the screen you build on has no button that opens twelve
 * connections, and the screen you launch from has no way to change what it is
 * about to open.
 *
 * Stays mounted like the other working pages, so a half-built template survives
 * a trip to Hosts to check a hostname.
 */
export function TemplatesPage({
  visible,
  connectedHostIds,
  focus,
  onOpenHelp,
  onOpenGridSettings,
  onBrowseTemplates,
}: {
  visible: boolean;
  connectedHostIds: Set<number>;
  focus: TemplateFocus | null;
  onOpenHelp: (section: HelpSectionId) => void;
  onOpenGridSettings: () => void;
  /** Go to the Hosts tab's Templates list, where all of them are. */
  onBrowseTemplates: () => void;
}) {
  const hint = useHint();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // A template deleted somewhere else while the editor was holding it. The
  // arrangement on the canvas is not lost, it has only lost the row it belonged
  // to, which is why the draft keeps its items and gives up its id: the button
  // goes back to saying Create, and pressing it writes this one back.
  const [vanished, setVanished] = useState(false);
  // Which template the editor has open, readable from a promise continuation
  // that must not be re-run every time the draft changes. The effect that
  // re-reads the list needs it at the moment the list comes back, and taking it
  // as a dependency would re-read on every keystroke in the name field.
  const openIdRef = useRef<number | null>(null);

  const [sort, setSort] = useState(
    () => localStorage.getItem(SORT_KEY) ?? "az",
  );
  const chooseSort = useCallback((next: string) => {
    setSort(next);
    localStorage.setItem(SORT_KEY, next);
  }, []);

  const src = useTemplateSources({ visible, sort, connectedHostIds });
  const filter = useRailFilter(src.hosts, "templates-rail-tags");

  const reload = useCallback(async () => {
    try {
      const list = await listTemplates();
      setTemplates(list);
      return list;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-read on every visit, so a template saved in one place is current in the
  // other. The chain is written out here rather than calling `reload` (which
  // the save and delete paths use) so the state write is visibly in a
  // continuation, and so a list arriving after the page is hidden is dropped.
  //
  // This is also where a template that went while the editor held it is
  // noticed. The check belongs on *this* read rather than on every list: the
  // save and delete paths reload immediately after writing, and there is a
  // render in the middle of a create where the draft already carries the new id
  // and the list does not yet, which would read as a template that vanished the
  // instant it was made.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    listTemplates()
      .then((list) => {
        if (!alive) return;
        setTemplates(list);
        const open = openIdRef.current;
        if (open != null && !list.some((t) => t.id === open)) {
          localStorage.removeItem(LAST_EDITED_KEY);
          setDraft((d) => (d && d.id === open ? { ...d, id: null } : d));
          setVanished(true);
        }
      })
      .catch((e) => {
        if (alive) toast.error(errorMessage(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [visible]);

  const openDraft = useCallback((next: Draft) => {
    setDraft(next);
    setBaseline(fingerprint(next));
  }, []);

  // Where the editor was last, so opening the tab on its own lands there. An
  // effect because it writes to something outside React and sets no state,
  // which is what an effect is for.
  //
  // The same number goes into the ref above, written in a *layout* effect,
  // which is where this codebase keeps its latest-value refs: a render can be
  // discarded and must not mutate anything outside itself, while a layout
  // effect lands before the browser paints, so nothing can read a value older
  // than the screen.
  const currentId = draft?.id ?? null;
  useLayoutEffect(() => {
    openIdRef.current = currentId;
  }, [currentId]);
  useEffect(() => {
    if (currentId != null) {
      localStorage.setItem(LAST_EDITED_KEY, String(currentId));
    }
  }, [currentId]);

  // A request from the Hosts tab: Add, or Edit on a particular row.
  //
  // Acted on during render rather than in an effect. An effect would paint one
  // frame of whatever was on screen before, which for Edit means the previous
  // template's boxes appearing under the new template's name. It converges
  // because consuming the serial makes the condition false.
  const [consumedFocus, setConsumedFocus] = useState(0);
  if (focus && focus.n !== consumedFocus) {
    setConsumedFocus(focus.n);
    if (focus.template) {
      openDraft(draftOf(focus.template));
    } else if (focus.items && focus.items.length > 0) {
      // The grid from the Terminals tab. Measured against an empty draft
      // rather than against itself, because nothing has been saved yet: the
      // arrangement is unsaved work from the first frame, and leaving it
      // behind should say so.
      setDraft({ ...EMPTY_DRAFT, items: focus.items });
      setBaseline(fingerprint(EMPTY_DRAFT));
    } else {
      openDraft(EMPTY_DRAFT);
    }
  }

  // Opened on its own: pick up where the operator left off. Once per run, so
  // closing the editor is not immediately undone by re-opening the same
  // template, and never while there is a draft, so it cannot throw away work.
  const [autoOpened, setAutoOpened] = useState(false);
  if (visible && !autoOpened && !loading && draft === null) {
    setAutoOpened(true);
    const last = Number(localStorage.getItem(LAST_EDITED_KEY));
    const found =
      templates.find((t) => t.id === last) ??
      [...templates].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (found) openDraft(draftOf(found));
  }

  const dirty = draft !== null && fingerprint(draft) !== baseline;

  // Most recently touched first, which is the order that makes a short list
  // useful. The Hosts tab shows them in the operator's own order, because that
  // is the one they open in.
  const recent = useMemo(
    () =>
      [...templates]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, SPLASH_RECENT),
    [templates],
  );

  usePageStatus(
    draft === null
      ? `${templates.length} ${templates.length === 1 ? "template" : "templates"}`
      : `${draft.name.trim() || "Untitled"} · ${draft.items.length} ${
          draft.items.length === 1 ? "session" : "sessions"
        }${dirty ? " · unsaved" : ""}`,
    visible,
  );

  /* ---------------------------------------------------------------- *
   * Editing the item list. Every one of these is a pure change to the
   * draft; nothing is written until Save.
   * ---------------------------------------------------------------- */

  const append = useCallback((item: TemplateItem) => {
    setDraft((d) => {
      if (!d || d.items.length >= MAX_TEMPLATE_ITEMS) return d;
      return { ...d, items: [...d.items, item] };
    });
  }, []);

  const insert = useCallback((item: TemplateItem, index: number) => {
    setDraft((d) => {
      if (!d || d.items.length >= MAX_TEMPLATE_ITEMS) return d;
      const items = [...d.items];
      items.splice(Math.min(index, items.length), 0, item);
      return { ...d, items };
    });
  }, []);

  const move = useCallback((from: number, to: number) => {
    setDraft((d) => (d ? { ...d, items: moveItem(d.items, from, to) } : d));
  }, []);

  const remove = useCallback((index: number) => {
    setDraft((d) =>
      d ? { ...d, items: d.items.filter((_, i) => i !== index) } : d,
    );
  }, []);

  /* ---------------------------------------------------------------- *
   * Saving, and the one warning that gates it.
   * ---------------------------------------------------------------- */

  const [pendingSave, setPendingSave] = useState<Draft | null>(null);
  const [dontWarnAgain, setDontWarnAgain] = useState(false);

  const persist = useCallback(
    async (d: Draft) => {
      setSaving(true);
      try {
        const input = {
          name: d.name.trim(),
          color: d.color,
          items: d.items,
          startup: d.startup,
        };
        const saved =
          d.id == null
            ? await createTemplate(input)
            : await updateTemplate(d.id, input);
        openDraft(draftOf(saved));
        await reload();
        toast.success(
          d.id == null ? `Created "${saved.name}"` : `Saved "${saved.name}"`,
        );
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setSaving(false);
      }
    },
    [openDraft, reload],
  );

  const requestSave = useCallback(() => {
    if (!draft || draft.name.trim() === "") return;
    // Opening connections before anyone has looked at the screen is the one
    // choice here worth stopping on. It is dismissible, because somebody who
    // means it will save this template often; the dismissal is recorded by name
    // and Settings can put it back.
    if (
      draft.startup === "connect" &&
      !isWarningDismissed("template-startup-connect")
    ) {
      setDontWarnAgain(false);
      setPendingSave(draft);
      return;
    }
    void persist(draft);
  }, [draft, persist]);

  /* ---------------------------------------------------------------- *
   * Export and import.
   * ---------------------------------------------------------------- */

  const [exportPending, setExportPending] = useState(false);

  const runExport = useCallback(async () => {
    if (!draft?.id) return;
    setExportPending(false);
    try {
      const path = await saveDialog({
        title: "Export template",
        defaultPath: `${draft.name.trim() || "template"}.broadside-template.json`,
        filters: [{ name: "Broadside template", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await exportTemplate(draft.id, path);
      toast.success("Template exported");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [draft]);

  const requestExport = useCallback(() => {
    if (!draft?.id) return;
    if (isWarningDismissed("template-export-refs")) {
      void runExport();
      return;
    }
    setDontWarnAgain(false);
    setExportPending(true);
  }, [draft, runExport]);

  const [importReplacing, setImportReplacing] = useState<Draft | null>(null);

  const runImport = useCallback(async () => {
    try {
      const path = await openDialog({
        title: "Import template",
        multiple: false,
        filters: [{ name: "Broadside template", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      const input = await readTemplateFile(path);
      const next: Draft = {
        id: null,
        name: input.name,
        color: input.color,
        items: input.items,
        startup: "off",
      };
      const unresolved = next.items.filter(
        (i) => i.kind === "host" && i.hostId == null,
      ).length;
      openDraft(next);
      toast.success(
        unresolved === 0
          ? `Imported "${next.name}". Press Create to save it.`
          : `Imported "${next.name}". ${unresolved} ${
              unresolved === 1 ? "reference" : "references"
            } didn't match a host here; point ${
              unresolved === 1 ? "it" : "them"
            } at one before saving.`,
      );
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [openDraft]);

  const requestImport = useCallback(() => {
    // An import replaces what is on the canvas. Unsaved work is worth one
    // question; a saved template is not, since it is still in the list.
    if (dirty && draft) {
      setImportReplacing(draft);
      return;
    }
    void runImport();
  }, [dirty, draft, runImport]);

  /* ---------------------------------------------------------------- *
   * Deleting and closing.
   * ---------------------------------------------------------------- */

  const [deleting, setDeleting] = useState<Draft | null>(null);
  const [discarding, setDiscarding] = useState(false);

  const runDelete = useCallback(async () => {
    const target = deleting;
    setDeleting(null);
    if (!target?.id) return;
    try {
      await deleteTemplate(target.id);
      localStorage.removeItem(LAST_EDITED_KEY);
      setDraft(null);
      setBaseline("");
      await reload();
      toast.success(`Deleted "${target.name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [deleting, reload]);

  const closeEditor = useCallback(() => {
    setDiscarding(false);
    setDraft(null);
    setBaseline("");
  }, []);

  const requestClose = useCallback(() => {
    if (dirty) {
      setDiscarding(true);
      return;
    }
    closeEditor();
  }, [dirty, closeEditor]);

  const pickTemplate = useCallback(
    (id: number | null) => {
      if (id == null) {
        openDraft(EMPTY_DRAFT);
        return;
      }
      const found = templates.find((t) => t.id === id);
      if (found) openDraft(draftOf(found));
    },
    [templates, openDraft],
  );

  const busy = (draft?.items.length ?? 0) > BUSY_TEMPLATE_ITEMS;

  const railProps = useMemo(
    () => ({
      sortedHosts: src.sortedHosts,
      enabledShells: src.enabledShells,
      customTerminals: src.customTerminals,
      sortedProfiles: src.sortedProfiles,
      shellColors: src.shellColors,
      hostsError: src.hostsError,
    }),
    [src],
  );

  // Nothing open in the editor. With no templates at all that is a fresh
  // install and takes the empty state every tab now shows; with some, it is
  // simply a closed editor, and what is wanted is the way back into one.
  if (draft === null) {
    return (
      <div className="flex h-full flex-col overflow-y-auto">
        <EmptyState
          icon={LayoutTemplateIcon}
          title="Templates"
          actionLabel={
            templates.length === 0 ? "Create your first template" : "New template"
          }
          onAction={() => openDraft(EMPTY_DRAFT)}
          actionHint="Start a new template: drag hosts and shells into the grid, then save it"
          secondaryLabel="Import"
          onSecondary={requestImport}
          secondaryHint="Read a template file someone exported. It opens in the editor, and nothing is saved until you press Create."
          description="A template is a saved arrangement of terminal sessions. Build it once here, then open the whole set from the Hosts tab in a single action."
          helpSection={HELP_TEMPLATES}
          onOpenHelp={onOpenHelp}
        />
        {templates.length > 0 && (
          <div className="mx-auto w-full max-w-md px-6 pb-16">
            <p className="mb-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Or edit a recent one
            </p>
            <div className="space-y-1">
              {recent.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openDraft(draftOf(t))}
                  className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/40"
                  {...hint(`Open "${t.name}" in the editor`)}
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 shrink-0 rounded-full border border-border",
                      !t.color && "border-dashed",
                    )}
                    style={t.color ? { backgroundColor: t.color } : undefined}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t.items.length}
                  </span>
                </button>
              ))}
            </div>
            {templates.length > recent.length && (
              <button
                type="button"
                onClick={onBrowseTemplates}
                className="mt-2 w-full text-center text-xs font-medium text-primary hover:underline"
                {...hint(
                  "Open the Hosts tab at the Templates list, where every one of them is",
                )}
              >
                Show all {templates.length} templates
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <TemplateRail
        {...railProps}
        filter={filter}
        sort={sort}
        onSortChange={chooseSort}
        onAdd={append}
        disabled={draft.items.length >= MAX_TEMPLATE_ITEMS}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TemplateTopBar
          templates={templates}
          currentId={draft.id}
          onPick={pickTemplate}
          name={draft.name}
          onNameChange={(name) => setDraft((d) => (d ? { ...d, name } : d))}
          color={draft.color}
          onColorChange={(color) => setDraft((d) => (d ? { ...d, color } : d))}
          startup={draft.startup}
          onStartupChange={(startup) =>
            setDraft((d) => (d ? { ...d, startup } : d))
          }
          saved={draft.id != null}
          dirty={dirty}
          saving={saving}
          onSave={requestSave}
          onCancel={requestClose}
          onDelete={() => setDeleting(draft)}
          onExport={requestExport}
          onImport={requestImport}
        />
        {busy && (
          <p
            className="shrink-0 border-b border-border/50 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400"
            {...hint(
              "Nothing is stopping you. Opening this many shells at once is slow on most machines, and the confirmation before a launch will say so.",
            )}
          >
            {draft.items.length} sessions is a lot to open at once. It will
            work; it will not be quick.
          </p>
        )}
        <TemplateCanvas
          items={draft.items}
          sources={src.sources}
          onInsert={insert}
          onMove={move}
          onRemove={remove}
          onOpenGridSettings={onOpenGridSettings}
          visible={visible}
        />
      </div>

      {/* Saving a template that connects everything at startup. */}
      <GuardDialog
        open={pendingSave !== null}
        onOpenChange={(o) => {
          if (!o) setPendingSave(null);
        }}
        title="Connect these sessions when Broadside starts?"
        warningId="template-startup-connect"
        dontWarn={dontWarnAgain}
        onDontWarnChange={setDontWarnAgain}
        confirmLabel="Save it"
        onConfirm={() => {
          const d = pendingSave;
          setPendingSave(null);
          if (d) void persist(d);
        }}
      >
        <p>
          This template will open{" "}
          <span className="font-semibold text-foreground">
            {pendingSave?.items.length ?? 0}
          </span>{" "}
          sessions and connect every one of them as soon as Broadside launches,
          before anyone has looked at the screen. On a shared or unattended
          machine that means live shells on those hosts from the moment the
          application starts.
        </p>
        <p>
          If you want the tabs without the connections, choose{" "}
          <span className="font-medium text-foreground">
            Open the tabs at startup
          </span>{" "}
          instead: each pane waits on its Reconnect button.
        </p>
      </GuardDialog>

      {/* Exporting host references. */}
      <GuardDialog
        open={exportPending}
        onOpenChange={(o) => {
          if (!o) setExportPending(false);
        }}
        title="This file names hosts, not connections"
        warningId="template-export-refs"
        dontWarn={dontWarnAgain}
        onDontWarnChange={setDontWarnAgain}
        confirmLabel="Export"
        onConfirm={() => void runExport()}
      >
        <p>
          A template stores each host by label, address, port and user name. The
          machine that imports it matches those against its own hosts, and
          anything it cannot match arrives as an empty box to be pointed at one.
        </p>
        <p>
          No credentials are written to the file, and importing it never creates
          or changes a host.
        </p>
      </GuardDialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{deleting?.name}&rdquo;?
            </AlertDialogTitle>
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

      {/* A template deleted on the Hosts tab while it was open here. */}
      <AlertDialog
        open={vanished}
        onOpenChange={(o) => {
          if (!o) setVanished(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {draft.name.trim()
                ? `“${draft.name.trim()}” was deleted`
                : "This template was deleted"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              It was removed while the editor was holding it, so there is
              nothing left to save over. What is on the canvas is untouched: the
              button now says Create, and pressing it writes this arrangement
              back as a new template. Discard closes the editor instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setVanished(false);
                closeEditor();
              }}
            >
              Discard
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setVanished(false);
                void persist({ ...draft, id: null });
              }}
            >
              Create
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discarding} onOpenChange={setDiscarding}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              This template has changes that have not been saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={closeEditor}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={importReplacing !== null}
        onOpenChange={(o) => {
          if (!o) setImportReplacing(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace what's on the canvas?</AlertDialogTitle>
            <AlertDialogDescription>
              Importing loads the file into the editor, and this template has
              unsaved changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setImportReplacing(null);
                void runImport();
              }}
            >
              Import anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * A warning that can be turned off, and can be turned back on.
 *
 * The checkbox is the reason this is its own component rather than two more
 * AlertDialogs inline: a "do not warn me again" that writes straight to
 * localStorage and forgets it happened is how a security warning disappears for
 * good. Every dismissal goes through `dismissWarning`, which records it by name
 * so Settings can list what has been silenced and put it all back.
 */
function GuardDialog({
  open,
  onOpenChange,
  title,
  warningId,
  dontWarn,
  onDontWarnChange,
  confirmLabel,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  warningId: WarningId;
  dontWarn: boolean;
  onDontWarnChange: (v: boolean) => void;
  confirmLabel: string;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="accent-primary"
            checked={dontWarn}
            onChange={(e) => onDontWarnChange(e.target.checked)}
          />
          Don&apos;t warn me about this again
        </label>
        <p className="text-xs text-muted-foreground">
          Warnings you turn off can be restored in Settings, under Security.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (dontWarn) dismissWarning(warningId);
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
