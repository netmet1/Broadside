import { useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  InfoIcon,
  ListOrderedIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_MAX_STEP_REPEATS,
  MAX_STEP_REPEATS_LIMIT,
  type Skill,
  type SkillInput,
} from "@/lib/tauri/skills";
import { useHint } from "@/lib/status";
import { StepEditor } from "@/pages/skills/StepEditor";
import {
  useSequenceForm,
  type SkillDraft,
} from "@/pages/skills/useSequenceForm";

/** The gap between two step cards, with a thin filled arrow centred in it.
 *
 * Decorative: it says "these run in order" at a glance, which is what the list
 * order actually means for a step whose branch is "continue to next step". The
 * real flow, branches and all, is the flow map on the overview. */
function StepConnector() {
  return (
    <div className="flex h-4 items-center justify-center" aria-hidden="true">
      <svg
        width="9"
        height="12"
        viewBox="0 0 9 12"
        className="fill-muted-foreground/45"
      >
        <rect x="4" y="0" width="1" height="7" />
        <path d="M4.5 12 0.5 5.5h8z" />
      </svg>
    </div>
  );
}

/** Builds or edits a sequence skill: the inputs it asks for, and the steps it
 * drives. */
export function SequenceBuilder({
  editing,
  template,
  onSave,
  onCancel,
}: {
  /** The skill being edited, or null for a new one. */
  editing: Skill | null;
  /** Seeds a *new* skill's fields from an existing one (Clone). Ignored while
   * editing: `editing` is both the source and the save target there. Nothing is
   * written until Create, so a clone can be abandoned by cancelling. */
  template?: SkillDraft | null;
  /** Resolves true when the save landed: the backend refuses a broken graph. */
  onSave: (id: number | null, input: SkillInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const hint = useHint();
  const f = useSequenceForm(editing ?? template ?? null);
  /** Ids of the steps folded down to their header.
   *
   * Everything starts folded, so opening a skill shows what it does as a short
   * list instead of a page of fields; a one-step skill (a new one) is the
   * exception, since there is nothing to summarise yet. A step you add is never
   * in here, so it opens ready to fill in.
   *
   * Ids, not indexes: moving a step must not fold a different one. Seeded once
   * on mount, which is correct because the editor remounts per skill. */
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    f.steps.length > 1 ? new Set(f.steps.map((s) => s.id)) : new Set(),
  );
  const allCollapsed = f.steps.every((s) => collapsed.has(s.id));

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  /** Renumber, keeping each step folded or open as it was. The ids the fold
   * state is keyed by are exactly what renumbering rewrites, so the same
   * position-to-id rule is applied here; without this, renumbering would spring
   * every card open. */
  const renumber = () => {
    const map = new Map(f.steps.map((s, i) => [s.id, `s${i + 1}`]));
    setCollapsed(
      (prev) => new Set([...prev].map((id) => map.get(id) ?? id)),
    );
    f.renumberSteps();
  };
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

        {/* The runaway guard. A branch that loops is a legitimate way to poll
            until something is ready, so it is capped rather than refused, and
            the cap is the author's to set: "check every 10 seconds up to 30
            times" is a real intent, and so is "if this has run twice something
            is wrong". */}
        <label
          className="flex flex-wrap items-center gap-1.5 text-sm"
          {...hint(
            "How many times any one step may run before the host stops with a 'branches loop without finishing' message. Counted per step, so this is the retry budget for a step that loops back on itself, not a limit on how long the skill can be.",
          )}
        >
          <span className="text-muted-foreground">Stop a host after a step runs</span>
          <Input
            type="number"
            min={1}
            max={MAX_STEP_REPEATS_LIMIT}
            value={f.maxStepRepeats}
            onChange={(e) =>
              f.setMaxStepRepeats(
                Math.min(
                  MAX_STEP_REPEATS_LIMIT,
                  Math.max(1, Number(e.target.value) || DEFAULT_MAX_STEP_REPEATS),
                ),
              )
            }
            className="h-7 w-20 text-xs"
          />
          <span className="text-muted-foreground">
            times ({MAX_STEP_REPEATS_LIMIT} max)
          </span>
        </label>

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
              disabled={f.steps.length < 2}
              onClick={() =>
                setCollapsed(
                  allCollapsed ? new Set() : new Set(f.steps.map((s) => s.id)),
                )
              }
              {...hint(
                allCollapsed
                  ? "Open every step"
                  : "Fold every step down to one line",
              )}
            >
              {allCollapsed ? (
                <ChevronsUpDownIcon className="mr-1 h-3 w-3" />
              ) : (
                <ChevronsDownUpIcon className="mr-1 h-3 w-3" />
              )}
              {allCollapsed ? "Expand all" : "Collapse all"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={renumber}
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

        <section>
          {f.steps.map((s, i) => (
            <div key={s.id}>
              {i > 0 && <StepConnector />}
              <StepEditor
                step={s}
                index={i}
                steps={f.steps}
                isStart={s.id === f.startStepId}
                collapsed={collapsed.has(s.id)}
                onToggleCollapsed={() => toggleCollapsed(s.id)}
                onChange={(next) => f.updateStep(i, next)}
                onAddStep={f.addStepReturningId}
                onRemove={() => f.removeStep(i)}
                onMove={(dir) => f.moveStep(i, dir)}
              />
            </div>
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

        {/* Soft warnings: worth flagging, but they don't block saving. Said out
            loud, because an amber box next to a Save button otherwise reads as
            "you have done something wrong and cannot continue". */}
        {f.warnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
            <p className="font-medium">
              Worth a look. None of this stops you saving or running the skill.
            </p>
            <ul className="space-y-0.5">
              {f.warnings.map((w) => (
                <li key={w}>· {w}</li>
              ))}
            </ul>
          </div>
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
