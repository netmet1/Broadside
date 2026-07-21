import { useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  InfoIcon,
  ListOrderedIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

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
  /** Resolves true when the save landed: the backend refuses a broken graph. */
  onSave: (id: number | null, input: SkillInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const hint = useHint();
  const f = useSequenceForm(editing);
  // The guidance is long and most of it you learn once. Collapsed by default so
  // it does not push the steps down the page every time you open the editor.
  const [notesOpen, setNotesOpen] = useState(false);
  // Inputs are collapsed by default too, so the pinned header stays short. Most
  // skills define a couple of inputs once and rarely touch them after.
  const [inputsOpen, setInputsOpen] = useState(false);

  const save = async () => {
    if (f.problems.length > 0) return;
    if (await onSave(editing?.id ?? null, f.toInput())) onCancel();
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* Everything from the Steps toolbar up is pinned to the top of the scroll
          area, so the Add input / Renumber / Add step buttons (and the start
          step) stay in reach however far down the step list you scroll. */}
      <div className="sticky top-0 z-10 space-y-5 border-b border-border/50 bg-background px-6 pb-4 pt-6">
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
              placeholder="Restart nginx"
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
              placeholder="Upgrade packages, then restart the web server"
              autoComplete="off"
            />
          </div>
        </div>

        {/* Opt-in: keep each host's shell open when the run finishes, so it can be
          handed to a terminal tab intact. Off by default; a lingering shell,
          above all a root one, is a standing exposure, so it is a deliberate
          choice with the risk spelled out when it's on. */}
        <div className="space-y-2">
          <label
            className="flex items-center gap-2 text-sm"
            {...hint(
              "Keep each host's shell open after the run so you can send it to a terminal tab with its root state, working directory and scrollback intact.",
            )}
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={f.allowTransfer}
              onChange={(e) => f.setAllowTransfer(e.target.checked)}
            />
            Allow transfer to a terminal tab
          </label>
          {f.allowTransfer && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
              <TriangleAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Each host's shell stays open after the run finishes until you
                close it or hand it to a terminal. If the skill ends as{" "}
                <span className="font-semibold">root</span>, that is a live root
                shell left standing, a security exposure. The upside: the shell
                you land in keeps its privileges, so a skill that escalates
                hands you a root terminal with no second sign-in.
              </span>
            </div>
          )}
        </div>

        {/* Inputs the run will ask for. Collapsed by default (like the notes) so
            the pinned header stays short; adding an input opens it. */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setInputsOpen((o) => !o)}
              className="flex min-w-0 items-center gap-2 text-left"
              aria-expanded={inputsOpen}
            >
              {inputsOpen ? (
                <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />
              )}
              <h3 className="text-sm font-medium">Inputs</h3>
              {f.params.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                  {f.params.length}
                </span>
              )}
            </button>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => {
                setInputsOpen(true);
                f.addParam();
              }}
            >
              <PlusIcon className="mr-1 h-3 w-3" />
              Add input
            </Button>
          </div>
          {inputsOpen && (
            <p className="text-xs text-muted-foreground">
              Values you fill in each time you run. Use them in a step as{" "}
              <code className="rounded bg-muted px-1">{"{{key}}"}</code>.
            </p>
          )}
          {inputsOpen &&
            f.params.map((p, i) => (
            <div
              key={i}
              className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-2"
            >
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Key</Label>
                <Input
                  value={p.key}
                  onChange={(e) =>
                    f.updateParam(i, { ...p, key: e.target.value })
                  }
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
                  onChange={(e) =>
                    f.updateParam(i, { ...p, label: e.target.value })
                  }
                  className="h-7 text-xs"
                  placeholder={p.key}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">
                  Default
                </Label>
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

        {/* Steps toolbar: stays pinned so its buttons are always in reach. */}
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
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={f.renumberSteps}
              disabled={f.steps.length < 2}
              {...hint(
                "Renames the step ids to s1, s2, ... in their current order and updates every branch to match, so the flow is unchanged. Tidies ids after reordering.",
              )}
            >
              <ListOrderedIcon className="mr-1 h-3 w-3" />
              Renumber
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={f.addStep}
            >
              <PlusIcon className="mr-1 h-3 w-3" />
              Add step
            </Button>
          </div>
        </div>
      </div>

      {/* Scrolling area: the guidance and the step cards. */}
      <div className="space-y-5 px-6 pb-6 pt-4">
        {/* Guidance, collapsed by default (it's a lot, and mostly learn-once). */}
        <div className="rounded-md border border-border/60 bg-muted/20 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setNotesOpen((o) => !o)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium"
            aria-expanded={notesOpen}
          >
            {notesOpen ? (
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" />
            )}
            <InfoIcon className="h-3.5 w-3.5 shrink-0" />
            Important notes
          </button>
          {notesOpen && (
            <div className="space-y-1 px-3 pb-3 pl-8">
              <p>
                The shell stays open for the whole run, so a{" "}
                <code className="rounded bg-muted px-1">sudo -i</code> early on
                leaves every later step running as root. Mark it{" "}
                <span className="font-medium">interactive</span>, since it opens
                a nested shell and never returns an exit code. A sudo password
                prompt is answered automatically from the host's stored sudo
                password, the same as in a terminal tab.
              </p>
              <p>
                For apt upgrades, prefix the command with{" "}
                <code className="rounded bg-muted px-1">
                  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
                </code>{" "}
                and pass <code className="rounded bg-muted px-1">-y</code>.{" "}
                <code className="rounded bg-muted px-1">DEBIAN_FRONTEND</code>{" "}
                alone is not enough: a kernel upgrade triggers needrestart,
                whose full-screen prompt takes over the terminal and stops the
                pane scrolling.{" "}
                <code className="rounded bg-muted px-1">
                  NEEDRESTART_MODE=a
                </code>{" "}
                stops that.
              </p>
              <p>
                Run a long command like an upgrade as a <em>normal</em> (not
                interactive) step with a big timeout. Then it waits for the
                command to actually finish, and if something unexpected blocks
                it, the step pauses for you rather than the engine typing over a
                prompt.
              </p>
            </div>
          )}
        </div>

        <section className="space-y-2">
          {f.steps.map((s, i) => (
            <StepEditor
              key={s.id}
              step={s}
              index={i}
              steps={f.steps}
              isStart={s.id === f.startStepId}
              onChange={(next) => f.updateStep(i, next)}
              onAddStep={f.addStepReturningId}
              onRemove={() => f.removeStep(i)}
              onMove={(dir) => f.moveStep(i, dir)}
            />
          ))}
        </section>

        {/* Blocking problems: Create/Save is disabled until these clear. */}
        {f.problems.length > 0 && (
          <ul className="space-y-0.5 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
            {f.problems.map((p) => (
              <li key={p}>· {p}</li>
            ))}
          </ul>
        )}

        {/* Soft warnings: worth flagging, but they don't block saving. */}
        {f.warnings.length > 0 && (
          <ul className="space-y-0.5 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
            {f.warnings.map((w) => (
              <li key={w}>· {w}</li>
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
    </div>
  );
}
