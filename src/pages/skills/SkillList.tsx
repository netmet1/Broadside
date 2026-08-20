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
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useHint } from "@/lib/status";
import { parseSequence, type Skill } from "@/lib/tauri/skills";

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
  onMove: (skill: Skill, direction: -1 | 1) => void;
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
  onMove,
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
  /** Moves a skill one place up (-1) or down (1) the rail. */
  onMove: (skill: Skill, direction: -1 | 1) => void;
}) {
  const hint = useHint();
  const actions: RowActions = {
    onRun,
    onWatch,
    onOpen,
    onEdit,
    onClone,
    onExport,
    onDelete,
    onMove,
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

      {/* Pick one skill and keep it in reach: the dropdown is the card's title,
          and the card under it stays put while the list below scrolls. The one
          you run twenty times a day is otherwise wherever the list happens to
          have scrolled to.

          It changes nothing about the list: no default moves, nothing is
          reordered, and the skill keeps its own place below. Hiding it there
          was the alternative and it makes the reorder arrows lie, since a skill
          you cannot see cannot be moved past. */}
      {showPicker && (
        <>
          <div className="shrink-0 px-3 pb-2">
            <select
              value={picked.id}
              onChange={(e) => setPickedId(Number(e.target.value))}
              aria-label="Pin a skill above the list"
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:border-ring"
            >
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="shrink-0 border-y border-primary/30 bg-primary/5 px-2 py-1.5">
            <SkillRow
              skill={picked}
              index={0}
              total={skills.length}
              showReorder={false}
              pinned={false}
              runState={runState}
              watching={watching}
              canRun={canRun}
              actions={actions}
            />
          </div>
        </>
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
          skills.map((s, i) => (
            <div
              key={s.id}
              className={`group mb-1 rounded-md px-2 py-1.5 ${
                selectedId === s.id
                  ? "bg-accent/40 ring-1 ring-primary/50"
                  : "hover:bg-accent/40"
              }`}
            >
              <SkillRow
                skill={s}
                index={i}
                total={skills.length}
                showReorder
                pinned={showPicker && picked.id === s.id}
                runState={runState}
                watching={watching}
                canRun={canRun}
                actions={actions}
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
  index: i,
  total,
  showReorder,
  pinned,
  runState,
  watching,
  canRun,
  actions,
}: {
  skill: Skill;
  /** Where this skill sits in the list, for the reorder arrows' end stops. */
  index: number;
  total: number;
  /** False on the pinned card: it is one skill out of its list, so up and down
   * have nothing to mean there. */
  showReorder: boolean;
  /** This row is the one the dropdown is pointing at, and so is also on the
   * card above. Marked rather than hidden. */
  pinned: boolean;
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
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left text-sm"
        title={s.name}
        onClick={() => actions.onOpen(s)}
        {...hint(`Open "${s.name}" to see its flow`)}
      >
        {pinned && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            title="Pinned above"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 truncate">{s.name}</span>
      </button>
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
              disabled={i === 0}
              onClick={() => actions.onMove(s, -1)}
              aria-label={`Move ${s.name} up`}
              {...hint(`Move "${s.name}" up the list`)}
            >
              <ChevronUpIcon className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-5 shrink-0 p-0"
              disabled={i === total - 1}
              onClick={() => actions.onMove(s, 1)}
              aria-label={`Move ${s.name} down`}
              {...hint(`Move "${s.name}" down the list`)}
            >
              <ChevronDownIcon className="h-3.5 w-3.5" />
            </Button>
          </>
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
