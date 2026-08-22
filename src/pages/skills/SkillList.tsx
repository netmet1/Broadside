import { useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useHint } from "@/lib/status";
import { parseSequence, type Skill } from "@/lib/tauri/skills";

/**
 * The mark on the skill in hand: a wash of emerald over whatever is behind it,
 * with a border of the same hue.
 *
 * One class for both themes, and a translucent one. A solid green dark enough
 * to belong in the dark theme has to bring its own foreground along, which
 * makes the card an island rather than part of the page; and both of the solid
 * greens tried before this shouted, which is the wrong volume for something
 * that is only saying "this one". Ten per cent over the rail is a tint you
 * notice without reading it as a warning, and it lands the same way at either
 * end of the theme because it is mostly the background underneath.
 */
const TINT = "border-emerald-500/25 bg-emerald-500/10";

/** How a skill's run is doing, when the run on this page is that skill's. */
type RunState = {
  skillId: number;
  status: "running" | "done" | "failed";
} | null;

/** Everything a skill row does, gathered up because the row is now rendered in
 * two places: down the scrollable list, and pinned above it as whatever the
 * dropdown is pointing at. */
type RowActions = {
  onRun: (skill: Skill) => void;
  onWatch: () => void;
  onOpen: (skill: Skill) => void;
  onEdit: (skill: Skill) => void;
  onClone: (skill: Skill) => void;
  onExport: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
  onSwap: (a: Skill, b: Skill) => void;
};

/** The rail's bottom half: every saved skill, with run / edit / delete. */
export function SkillList({
  skills,
  loading,
  selectedId,
  runState,
  watching,
  canRun,
  onRun,
  onWatch,
  onOpen,
  onEdit,
  onNew,
  onClone,
  onImport,
  onExport,
  onDelete,
  onSwap,
}: {
  skills: Skill[];
  loading: boolean;
  selectedId: number | null;
  /**
   * The skill this page has a run for, and how that run is doing. Null once the
   * run is cleared and the page is back at the picker.
   *
   * The skill id and the status travel together on purpose. They were a bare
   * `runningSkillId` derived from "is there a run id", which is true from the
   * moment a run starts until the operator clears it, so the rail went on
   * saying `running` in green long after every host had finished or failed. A
   * run id says a run exists; it says nothing about whether it is still going.
   */
  runState: RunState;
  /** Whether the run panel is the thing currently on screen. */
  watching: boolean;
  /** False when no host is checked, or a run is already going. */
  canRun: boolean;
  onRun: (skill: Skill) => void;
  onWatch: () => void;
  /** Opens the skill's overview: its flow map and what it does, with Edit one
   * click further in. What clicking the skill's name does. */
  onOpen: (skill: Skill) => void;
  /** Straight into the editor, skipping the flow map. What the pencil does: it
   * is the "I already know what I want to change" route. */
  onEdit: (skill: Skill) => void;
  onNew: () => void;
  /** Opens the editor on a fresh, unsaved copy of this skill. */
  onClone: (skill: Skill) => void;
  onImport: () => void;
  onExport: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
  /** Exchanges two skills' places in the rail. The arrows work it out from the
   * list as displayed, which is not the whole list once a skill is pinned. */
  onSwap: (a: Skill, b: Skill) => void;
}) {
  const hint = useHint();

  /**
   * Whether the tint has followed you down into the list.
   *
   * The green marks the skill in hand, and the card is where that starts.
   * Open one from the list and the tint goes with you, off the card and onto
   * that row, so the rail never shows two skills dressed as the current one.
   * Touch the dropdown and it comes back up: choosing what is pinned is
   * choosing what you are working on.
   *
   * Set where the click happens rather than derived from `selectedId`, because
   * opening the row you already had open has to bring the tint back down and a
   * selection that did not change cannot say so.
   */
  const [tintInList, setTintInList] = useState(false);

  const actions: RowActions = {
    onRun,
    onWatch,
    onOpen,
    onEdit,
    onClone,
    onExport,
    onDelete,
    onSwap,
  };
  /** The card and the list rows differ in one thing: where opening a skill
   * leaves the tint. Everything else they do is identical. */
  const cardActions: RowActions = {
    ...actions,
    onOpen: (s) => {
      setTintInList(false);
      onOpen(s);
    },
  };
  const listActions: RowActions = {
    ...actions,
    onOpen: (s) => {
      setTintInList(true);
      onOpen(s);
    },
  };

  /**
   * The skill the dropdown is pointing at, or null for "whichever is top".
   *
   * Null rather than seeding it with the first skill's id: the default is a
   * *position*, not a skill, so a reorder that puts something else on top moves
   * the default with it, and the list arriving after the first render does not
   * need an effect to catch up. Resolving through `find` also means a deleted
   * skill falls back to the top of the list rather than leaving the card
   * pointing at nothing.
   */
  const [pickedId, setPickedId] = useState<number | null>(null);
  const picked = skills.find((s) => s.id === pickedId) ?? skills[0] ?? null;
  // One skill is not a choice, and the card would be that same row twice in a
  // rail that has none to spare.
  const showPicker = skills.length > 1 && picked !== null;

  /** The list as displayed: everything except the skill on the card. It is
   * already on screen, above, and a rail this narrow cannot spare the row. */
  const listed = showPicker ? skills.filter((s) => s.id !== picked.id) : skills;

  /** The row wearing the tint, if any. Falls back to the card when the tint's
   * row is gone: deleted, or just pinned and so lifted out of the list. */
  const tintedRow =
    showPicker && tintInList && listed.some((s) => s.id === selectedId)
      ? selectedId
      : null;
  /** The card is the skill in hand, which is also what makes its title open on
   * one click rather than two. */
  const cardIsCurrent = tintedRow === null;

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/50">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-sm font-medium">Skills</span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onImport}
            {...hint("Import a skill from a .json file. You'll see its steps before it's saved.")}
          >
            <UploadIcon className="mr-1 h-3 w-3" />
            Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={onNew}
            {...hint("Build a new skill: a sequence of commands and prompt answers")}
          >
            <PlusIcon className="mr-1 h-3 w-3" />
            New
          </Button>
        </div>
      </div>

      {/* Pick one skill and keep it in reach: one card, titled by the dropdown
          that chooses what is on it, staying put while the list below scrolls.
          The one you run twenty times a day is otherwise wherever the list
          happens to have scrolled to.

          The pinned skill leaves the list while it is up here. It was left in
          place at first, marked with a dot, so that the reorder arrows could
          still move it and nothing had to be moved past a row that was not
          drawn. In use it just read as the same skill twice in a rail sixteen
          rems wide. So it goes, the arrows below swap visible neighbours
          instead of adjacent ones, and the one thing given up is reordering
          the pinned skill itself: pick another and it comes back to the list
          with its arrows. */}
      {showPicker && (
        <div
          className={cn(
            "shrink-0 border-y px-2 py-1.5",
            cardIsCurrent
              ? TINT
              : "border-border/50 bg-muted/30 dark:bg-muted/20",
            selectedId === picked.id && "ring-1 ring-primary/50",
          )}
        >
          {/* The dropdown is the card's title: what it says is what the card
              is showing, and changing it swaps the card. Two controls saying
              the same skill's name, one above the other, was a row of a
              sixteen-rem rail spent on repeating itself.

              Two clicks when the card is not the one in hand. The first only
              brings the tint back and takes focus; the second opens the list.
              The title of a card you are not looking at is a wide, easy target
              sitting directly above the skill list, and a stray click on it
              should not put a menu over the rail. Once the card is the current
              one it opens on a single click like anything else, because by
              then you meant it. */}
          <select
            value={picked.id}
            onChange={(e) => {
              setPickedId(Number(e.target.value));
              // Choosing what is pinned is choosing what you are working on,
              // so the tint comes back up here from wherever it had got to.
              setTintInList(false);
            }}
            onMouseDown={(e) => {
              if (cardIsCurrent) return;
              // Chromium opens the picker on mousedown, so this is where it
              // has to be stopped. Doing so also swallows the focus the click
              // would have moved, hence taking it by hand: the second click
              // needs a focused control to be the second click of a pair.
              e.preventDefault();
              e.currentTarget.focus();
              setTintInList(false);
            }}
            aria-label="Pinned skill"
            title={picked.name}
            className="-mx-1 w-full cursor-pointer rounded bg-transparent px-1 text-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring"
            {...hint(
              cardIsCurrent
                ? "Choose which skill is pinned here"
                : "Bring the pinned card back into focus. Click again to choose a skill.",
            )}
          >
            {skills.map((s) => (
              // The popup is drawn by the browser, not by us, and it takes its
              // colours from the options rather than from the transparent
              // control or the card behind it. Without these the dark theme
              // opens a white list and puts near-white text in it.
              <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                {s.name}
              </option>
            ))}
          </select>
          <SkillRow
            skill={picked}
            prev={null}
            next={null}
            showReorder={false}
            showName={false}
            runState={runState}
            watching={watching}
            canRun={canRun}
            actions={cardActions}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">Loading…</p>
        ) : skills.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No skills yet. A skill opens a live shell on each checked host and
            drives it: running commands, watching for prompts and answering
            them. Press New to build one.
          </p>
        ) : (
          listed.map((s, i) => (
            <div
              key={s.id}
              className={cn(
                "group mb-1 rounded-md border border-transparent px-2 py-1.5",
                // The tint replaces the accent wash rather than sitting on top
                // of it: two backgrounds on one row is a muddier colour, not a
                // louder signal. The ring stays either way, because it is the
                // ring that says "open", not the fill.
                tintedRow === s.id
                  ? TINT
                  : selectedId === s.id
                    ? "bg-accent/40"
                    : "hover:bg-accent/40",
                selectedId === s.id && "ring-1 ring-primary/50",
              )}
            >
              <SkillRow
                skill={s}
                prev={listed[i - 1] ?? null}
                next={listed[i + 1] ?? null}
                showReorder
                runState={runState}
                watching={watching}
                canRun={canRun}
                actions={listActions}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** One skill: its name, what it is, and what you can do to it. */
function SkillRow({
  skill: s,
  prev,
  next,
  showReorder,
  showName = true,
  runState,
  watching,
  canRun,
  actions,
}: {
  skill: Skill;
  /** The rows either side of this one *as drawn*, which the arrows trade
   * places with. Null at the ends of the list, which is what stops them. Rows
   * rather than an index, because the list drawn skips the pinned skill and an
   * index into it would not say who the neighbour actually is. */
  prev: Skill | null;
  next: Skill | null;
  /** False on the pinned card: it is one skill out of its list, so up and down
   * have nothing to mean there. */
  showReorder: boolean;
  /** False on the pinned card, where the dropdown above is already the skill's
   * name. Clicking the name is how you reach a skill's flow map, so the card
   * gets that as a button instead: without it the pinned skill would be the
   * one skill on the page with no way through to its flow. */
  showName?: boolean;
  runState: RunState;
  watching: boolean;
  canRun: boolean;
  actions: RowActions;
}) {
  const hint = useHint();
  const steps = parseSequence(s.config_json).steps.length;
  // This skill's run, if the run on this page is this skill's. Null for every
  // other row.
  const status = runState?.skillId === s.id ? runState.status : null;
  // A run that still has somewhere to go. The eye stays available after that,
  // because the panes and their transcripts are still there until the run is
  // cleared, and going back to read why a host failed is the first thing
  // anyone does.
  const running = status === "running";

  return (
    <>
      {showName && (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-left text-sm"
          title={s.name}
          onClick={() => actions.onOpen(s)}
          {...hint(`Open "${s.name}" to see its flow`)}
        >
          <span className="min-w-0 truncate">{s.name}</span>
        </button>
      )}
      <div className="flex items-center gap-1.5 pr-1 text-[10px] text-muted-foreground">
        <span className="shrink-0">
          {steps} {steps === 1 ? "step" : "steps"}
        </span>
        {status !== null && (
          <span
            className={cn(
              "shrink-0 font-medium",
              status === "running" && "text-emerald-500",
              status === "done" && "text-muted-foreground",
              status === "failed" && "text-red-500",
            )}
          >
            {status === "running"
              ? "running"
              : status === "done"
                ? "finished"
                : "failed"}
          </span>
        )}
        {s.kind === "ai" && (
          <span className="shrink-0 rounded-full bg-muted px-1.5">AI</span>
        )}
        {s.description && (
          <span className="min-w-0 truncate" title={s.description}>
            · {s.description}
          </span>
        )}
      </div>
      {/* The controls get their own row rather than sharing the name's.
          Four buttons in a 16rem rail left the name a few characters
          wide, which is the one thing you actually read. */}
      <div className="mt-0.5 flex items-center gap-0.5">
        {showReorder && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-5 shrink-0 p-0"
              disabled={prev === null}
              onClick={() => prev && actions.onSwap(s, prev)}
              aria-label={`Move ${s.name} up`}
              {...hint(`Move "${s.name}" up the list`)}
            >
              <ChevronUpIcon className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-5 shrink-0 p-0"
              disabled={next === null}
              onClick={() => next && actions.onSwap(s, next)}
              aria-label={`Move ${s.name} down`}
              {...hint(`Move "${s.name}" down the list`)}
            >
              <ChevronDownIcon className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        {/* The card's stand-in for clicking the name, in the space the list
            rows give their arrows. */}
        {!showName && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0"
            onClick={() => actions.onOpen(s)}
            aria-label={`Open ${s.name}`}
            {...hint(`Open "${s.name}" to see its flow`)}
          >
            <WorkflowIcon className="h-3.5 w-3.5" />
          </Button>
        )}
        <span className="flex-1" />
        {status !== null ? (
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-6 w-6 shrink-0 p-0",
              watching
                ? "text-primary"
                : running
                  ? "text-emerald-500"
                  : "text-muted-foreground",
            )}
            onClick={actions.onWatch}
            aria-label={
              running ? `Watch ${s.name} running` : `Go back to ${s.name}'s run`
            }
            {...hint(
              running
                ? watching
                  ? `"${s.name}" is running; you are watching it`
                  : `"${s.name}" is running. Go back to its live terminals.`
                : watching
                  ? `"${s.name}" has finished; you are looking at its run`
                  : `"${s.name}" has finished. Go back to what each host reported.`,
            )}
          >
            <EyeIcon className="h-3.5 w-3.5" />
          </Button>
        ) : (
          // The hint lives on the wrapper, not the button: a disabled
          // button emits no mouse events, so a hint on it would never
          // fire, which is exactly when the operator most needs to be
          // told why they can't press it.
          <span
            className="shrink-0"
            {...hint(
              canRun
                ? `Run "${s.name}" on the checked hosts`
                : "Check at least one host on the left first",
            )}
          >
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              disabled={!canRun}
              onClick={() => actions.onRun(s)}
              aria-label={`Run ${s.name}`}
            >
              <PlayIcon className="h-3.5 w-3.5" />
            </Button>
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          onClick={() => actions.onEdit(s)}
          aria-label={`Edit ${s.name}`}
          {...hint(
            `Edit "${s.name}" directly. Click its name instead to see the flow first.`,
          )}
        >
          <PencilIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          onClick={() => actions.onClone(s)}
          aria-label={`Clone ${s.name}`}
          {...hint(
            `Start a new skill from a copy of "${s.name}". Nothing is saved until you press Create.`,
          )}
        >
          <CopyIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0"
          onClick={() => actions.onExport(s)}
          aria-label={`Export ${s.name}`}
          {...hint(`Export "${s.name}" to a .json file (definition only, no credentials)`)}
        >
          <DownloadIcon className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          onClick={() => actions.onDelete(s)}
          aria-label={`Delete ${s.name}`}
          {...hint(`Delete "${s.name}"`)}
        >
          <Trash2Icon className="h-3.5 w-3.5" />
        </Button>
      </div>
    </>
  );
}
