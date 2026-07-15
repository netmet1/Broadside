import { InfoIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Skill, SkillInput } from "@/lib/tauri/skills";
import { useHint } from "@/lib/status";
import { StepEditor } from "@/pages/skills/StepEditor";
import { useSequenceForm } from "@/pages/skills/useSequenceForm";

/** Builds or edits a sequence skill: the inputs it asks for, and the steps it
 * drives. */
export function SequenceBuilder({
  editing,
  onSave,
  onCancel,
}: {
  /** The skill being edited, or null for a new one. */
  editing: Skill | null;
  /** Resolves true when the save landed — the backend refuses a broken graph. */
  onSave: (id: number | null, input: SkillInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const hint = useHint();
  const f = useSequenceForm(editing);

  const save = async () => {
    if (f.problems.length > 0) return;
    if (await onSave(editing?.id ?? null, f.toInput())) onCancel();
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6">
      <h2 className="text-lg font-semibold">
        {editing ? `Edit ${editing.name}` : "New skill"}
      </h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="skill-name" className="text-xs">
            Name
          </Label>
          <Input
            id="skill-name"
            value={f.name}
            onChange={(e) => f.setName(e.target.value)}
            placeholder="Restart validator"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="skill-desc" className="text-xs">
            Description
          </Label>
          <Input
            id="skill-desc"
            value={f.description}
            onChange={(e) => f.setDescription(e.target.value)}
            placeholder="Upgrade, clean, and bring the validator back up"
            autoComplete="off"
          />
        </div>
      </div>

      {/* Inputs the run will ask for. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium">Inputs</h3>
            <p className="text-xs text-muted-foreground">
              Values you fill in each time you run. Use them in a step as{" "}
              <code className="rounded bg-muted px-1">{"{{key}}"}</code>.
            </p>
          </div>
          <Button variant="outline" size="sm" className="h-7" onClick={f.addParam}>
            <PlusIcon className="mr-1 h-3 w-3" />
            Add input
          </Button>
        </div>
        {f.params.map((p, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-2">
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Key</Label>
              <Input
                value={p.key}
                onChange={(e) => f.updateParam(i, { ...p, key: e.target.value })}
                className="h-7 w-32 font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <Label className="text-[10px] text-muted-foreground">
                Label shown at run time
              </Label>
              <Input
                value={p.label}
                onChange={(e) => f.updateParam(i, { ...p, label: e.target.value })}
                className="h-7 text-xs"
                placeholder={p.key}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] text-muted-foreground">Default</Label>
              <Input
                value={p.default ?? ""}
                onChange={(e) =>
                  f.updateParam(i, { ...p, default: e.target.value })
                }
                className="h-7 w-28 font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <label className="flex h-7 items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="accent-primary"
                checked={p.required}
                onChange={(e) =>
                  f.updateParam(i, { ...p, required: e.target.checked })
                }
              />
              Required
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => f.removeParam(i)}
              aria-label="Remove input"
            >
              <Trash2Icon className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </section>

      {/* Steps. */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Steps</h3>
          <div className="flex items-center gap-2">
            <label
              className="flex items-center gap-1.5 text-xs"
              {...hint("Which step the skill starts with")}
            >
              <span className="text-muted-foreground">Start at</span>
              <select
                value={f.startStepId}
                onChange={(e) => f.setStartStepId(e.target.value)}
                className="rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
              >
                {f.steps.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="outline" size="sm" className="h-7" onClick={f.addStep}>
              <PlusIcon className="mr-1 h-3 w-3" />
              Add step
            </Button>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-1">
            <p>
              The shell stays open for the whole run, so a{" "}
              <code className="rounded bg-muted px-1">sudo -i</code> early on
              leaves every later step running as root. Mark it{" "}
              <span className="font-medium">interactive</span> — it opens a
              nested shell and never returns an exit code.
            </p>
            <p>
              For apt and dpkg, use{" "}
              <code className="rounded bg-muted px-1">
                DEBIAN_FRONTEND=noninteractive
              </code>{" "}
              and <code className="rounded bg-muted px-1">-y</code> so a config
              dialog can't block the run, and raise the timeout — an upgrade can
              take a while.
            </p>
          </div>
        </div>

        {f.steps.map((s, i) => (
          <StepEditor
            key={s.id}
            step={s}
            index={i}
            steps={f.steps}
            isStart={s.id === f.startStepId}
            onChange={(next) => f.updateStep(i, next)}
            onRemove={() => f.removeStep(i)}
            onMove={(dir) => f.moveStep(i, dir)}
          />
        ))}
      </section>

      {f.problems.length > 0 && (
        <ul className="space-y-0.5 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
          {f.problems.map((p) => (
            <li key={p}>· {p}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={f.problems.length > 0}>
          {editing ? "Save changes" : "Create skill"}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
