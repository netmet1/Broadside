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
  runState: {
    skillId: number;
    status: "running" | "done" | "failed";
  } | null;
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
          skills.map((s, i) => {
            const steps = parseSequence(s.config_json).steps.length;
            // This skill's run, if the run on this page is this skill's. Null
            // for every other row.
            const status = runState?.skillId === s.id ? runState.status : null;
            // A run that still has somewhere to go. The eye stays available
            // after that, because the panes and their transcripts are still
            // there until the run is cleared, and going back to read why a host
            // failed is the first thing anyone does.
            const running = status === "running";
            return (
              <div
                key={s.id}
                className={`group mb-1 rounded-md px-2 py-1.5 ${
                  selectedId === s.id ? "bg-accent/40 ring-1 ring-primary/50" : "hover:bg-accent/40"
                }`}
              >
                <button
                  type="button"
                  className="block w-full truncate text-left text-sm"
                  title={s.name}
                  onClick={() => onOpen(s)}
                  {...hint(`Open "${s.name}" to see its flow`)}
                >
                  {s.name}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-5 shrink-0 p-0"
                    disabled={i === 0}
                    onClick={() => onMove(s, -1)}
                    aria-label={`Move ${s.name} up`}
                    {...hint(`Move "${s.name}" up the list`)}
                  >
                    <ChevronUpIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-5 shrink-0 p-0"
                    disabled={i === skills.length - 1}
                    onClick={() => onMove(s, 1)}
                    aria-label={`Move ${s.name} down`}
                    {...hint(`Move "${s.name}" down the list`)}
                  >
                    <ChevronDownIcon className="h-3.5 w-3.5" />
                  </Button>
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
                      onClick={onWatch}
                      aria-label={
                        running
                          ? `Watch ${s.name} running`
                          : `Go back to ${s.name}'s run`
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
                        onClick={() => onRun(s)}
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
                    onClick={() => onEdit(s)}
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
                    onClick={() => onClone(s)}
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
                    onClick={() => onExport(s)}
                    aria-label={`Export ${s.name}`}
                    {...hint(`Export "${s.name}" to a .json file (definition only, no credentials)`)}
                  >
                    <DownloadIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(s)}
                    aria-label={`Delete ${s.name}`}
                    {...hint(`Delete "${s.name}"`)}
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
