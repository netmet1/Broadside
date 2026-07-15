import { PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHint } from "@/lib/status";
import { parseSequence, type Skill } from "@/lib/tauri/skills";

/** The rail's bottom half: every saved skill, with run / edit / delete. */
export function SkillList({
  skills,
  loading,
  selectedId,
  canRun,
  onRun,
  onEdit,
  onNew,
  onDelete,
}: {
  skills: Skill[];
  loading: boolean;
  selectedId: number | null;
  /** False when no host is checked — running has no target. */
  canRun: boolean;
  onRun: (skill: Skill) => void;
  onEdit: (skill: Skill) => void;
  onNew: () => void;
  onDelete: (skill: Skill) => void;
}) {
  const hint = useHint();

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border/50">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <span className="text-sm font-medium">Skills</span>
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

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">Loading…</p>
        ) : skills.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No skills yet. A skill opens a live shell on each checked host and
            drives it — running commands, watching for prompts and answering
            them. Press New to build one.
          </p>
        ) : (
          skills.map((s) => {
            const steps = parseSequence(s.config_json).steps.length;
            return (
              <div
                key={s.id}
                className={`group mb-1 rounded-md px-2 py-1.5 ${
                  selectedId === s.id ? "bg-accent/40 ring-1 ring-primary/50" : "hover:bg-accent/40"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm" title={s.name}>
                    {s.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 shrink-0 p-0"
                    disabled={!canRun}
                    onClick={() => onRun(s)}
                    aria-label={`Run ${s.name}`}
                    {...hint(
                      canRun
                        ? `Run "${s.name}" on the checked hosts`
                        : "Check at least one host first",
                    )}
                  >
                    <PlayIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 shrink-0 p-0"
                    onClick={() => onEdit(s)}
                    aria-label={`Edit ${s.name}`}
                    {...hint(`Edit "${s.name}"`)}
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
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
                <div className="flex items-center gap-1.5 pr-1 text-[10px] text-muted-foreground">
                  <span className="shrink-0">
                    {steps} {steps === 1 ? "step" : "steps"}
                  </span>
                  {s.kind === "ai" && (
                    <span className="shrink-0 rounded-full bg-muted px-1.5">AI</span>
                  )}
                  {s.description && (
                    <span className="min-w-0 truncate" title={s.description}>
                      · {s.description}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
