import { useEffect, useRef, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
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
 * order actually means for a step whose branch is "next step below". The
 * real flow, branches and all, is the flow map on the overview. */
function StepConnector() {
  return (
    <div className="flex h-11 items-center justify-center" aria-hidden="true">
      <svg
        width="16"
        height="24"
        viewBox="0 0 16 24"
        className="fill-muted-foreground/70"
      >
        <rect x="7" y="0" width="2" height="13" />
        <path d="M8 24 1 13h14z" />
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
  /** Resolves to the saved skill's id, or null when the save did not land: the
   * backend refuses a broken graph. The id matters for Save-without-closing on
   * a new skill, which has to know what it just created. */
  onSave: (id: number | null, input: SkillInput) => Promise<number | null>;
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
  /** The step last interacted with, tinted so it stands out and, more to the
   * point, so it stays followable when the up/down arrows move it a row at a
   * time. By id, so the tint travels with the card rather than staying on the
   * position it left. */
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  /** Bumped by Add step, to scroll the new card into view. A step lands at the
   * bottom of the list, which on a skill of any size is off screen, so without
   * this the button appears to do nothing at all. */
  const [addedNonce, setAddedNonce] = useState(0);
  const listEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (addedNonce === 0) return;
    listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [addedNonce]);

  const addStep = () => {
    f.addStep();
    setAddedNonce((n) => n + 1);
  };

  /** Each card, by step id, so a branch can scroll to the step it points at. */
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  /** The step a branch's jump button asked for, bumped so the same target twice
   * running still scrolls. The scroll waits for a render because the jump also
   * unfolds the card, which moves everything below it. */
  const [jump, setJump] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!jump) return;
    // `center`, not `start`: the toolbar above is sticky, and a card scrolled to
    // the top of the area lands underneath it.
    cardRefs.current
      .get(jump.id)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [jump]);
  /** Follow a branch to the step it names: open it, tint it, scroll to it.
   *
   * A branch dropdown reading `s7` tells you nothing about what s7 is, and on a
   * skill of any size s7 is not on screen. This is the shortest path from "where
   * does this go" to reading the step it goes to. */
  const jumpToStep = (id: string) => {
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setActiveStepId(id);
    setJump((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  };

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
  /** What the repeat-cap box shows while it is being edited. Held as text so it
   * can legally be empty for a moment; `f.maxStepRepeats` is what gets saved. */
  const [repeatsText, setRepeatsText] = useState(String(f.maxStepRepeats));
  // The guidance is long and most of it you learn once. Collapsed by default so
  // it does not push the steps down the page every time you open the editor.
  const [notesOpen, setNotesOpen] = useState(false);
  // Inputs are collapsed by default too, so the pinned header stays short. Most
  // skills define a couple of inputs once and rarely touch them after.
  const [inputsOpen, setInputsOpen] = useState(false);

  /**
   * What the next save writes to: the skill being edited, or the one this
   * editor created a moment ago.
   *
   * Save no longer closes, so a new skill can be saved twice, and the second
   * press has to update the first press's row rather than create another. The
   * form is keyed on open (see SkillsPage), so this starts fresh every visit
   * and cannot carry a previous skill's id into a new one.
   */
  const [savedId, setSavedId] = useState<number | null>(editing?.id ?? null);
  /** The form as it stood when it was opened, or when it was last saved.
   * Compared with the form now to answer "is there anything to lose", which is
   * the only question Cancel needs to ask. */
  const [baseline, setBaseline] = useState(() => JSON.stringify(f.toInput()));
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /** Saves, and closes only if asked. Returns nothing: the buttons below are
   * the only callers and neither has anything to do afterwards. */
  const save = async (thenClose: boolean) => {
    if (f.problems.length > 0) return;
    const input = f.toInput();
    const id = await onSave(savedId, input);
    // Refused by the backend. The editor stays exactly as it is, with the
    // toast saying why, rather than closing over the top of the problem.
    if (id == null) return;
    setSavedId(id);
    setBaseline(JSON.stringify(input));
    if (thenClose) onCancel();
  };

  /** Cancel, but not over the top of unsaved work. */
  const cancel = () => {
    if (JSON.stringify(f.toInput()) !== baseline) {
      setConfirmDiscard(true);
      return;
    }
    onCancel();
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
              "Keep each host's shell open after the run, with its root state, working directory and scrollback intact.",
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
        <div className="space-y-2">
        <label
          className={`flex flex-wrap items-center gap-1.5 text-sm ${
            f.unlimitedStepRepeats ? "opacity-50" : ""
          }`}
          {...hint(
            "How many times any one step may run before the host stops. A retry budget per step, not a limit on the skill's length.",
          )}
        >
          <span className="text-muted-foreground">Stop a host after a step runs</span>
          <Input
            type="number"
            min={1}
            max={MAX_STEP_REPEATS_LIMIT}
            value={repeatsText}
            onChange={(e) => {
              // Keep what was typed, so clearing the box to type a new number
              // doesn't snap to something under your cursor mid-keystroke. Only
              // a value that is already in range is committed here; the rest is
              // settled on blur.
              setRepeatsText(e.target.value);
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n) && n >= 1) {
                f.setMaxStepRepeats(Math.min(MAX_STEP_REPEATS_LIMIT, n));
              }
            }}
            onBlur={() => {
              // Empty or 0 means 1, not the default: a cleared box reads as
              // "the smallest allowed", and jumping back to 100 there quietly
              // undid what the operator was doing.
              const n = Math.min(
                MAX_STEP_REPEATS_LIMIT,
                Math.max(1, Math.floor(Number(repeatsText)) || 1),
              );
              setRepeatsText(String(n));
              f.setMaxStepRepeats(n);
            }}
            disabled={f.unlimitedStepRepeats}
            className="h-7 w-20 text-xs"
          />
          <span className="text-muted-foreground">
            times ({MAX_STEP_REPEATS_LIMIT} max)
          </span>
        </label>

        {/* Taking the cap off removes the engine's only guarantee that a
            looping skill ever ends, so it is opt-in, off by default, and says
            plainly what it costs. Not refused: polling something that genuinely
            has no bound is a real job, and an operator who knows that is better
            served by a documented switch than by a limit they work around with
            ninety-nine copies of a step. */}
        <label
          className="flex items-start gap-2 text-sm"
          {...hint(
            "Remove the repeat cap. A skill that loops then runs until you stop the host yourself. Dangerous.",
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-destructive"
            checked={f.unlimitedStepRepeats}
            onChange={(e) => f.setUnlimitedStepRepeats(e.target.checked)}
          />
          <span>
            Let steps repeat without limit{" "}
            <span className="text-muted-foreground">(no cap)</span>
          </span>
        </label>
        {f.unlimitedStepRepeats && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <TriangleAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="font-semibold">
                Dangerous. Use this only if you truly know what you are doing.
              </span>{" "}
              With no cap, a skill whose branches loop will never finish on its
              own: it keeps running steps against every host it is on until{" "}
              <span className="font-medium">you</span> stop it. A loop that
              writes files, starts processes or installs things can fill a disk
              or exhaust memory on the far side, and every host it touched holds
              an open shell for as long as it runs.{" "}
              <span className="font-medium">Stop host</span> and the{" "}
              <span className="font-medium">emergency stop</span> still work, and
              they are the only things that will end it. Leave this off unless
              the skill is genuinely waiting for something with no bound, and
              watch it while it runs.
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
                "Renames the step ids to s1, s2, ... in their current order and updates every branch to match.",
              )}
            >
              <ListOrderedIcon className="mr-1 h-3 w-3" />
              Renumber
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={addStep}
            >
              <PlusIcon className="mr-1 h-3 w-3" />
              Add step
            </Button>
          </div>
        </div>
      </div>

      {/* Scrolling area: the guidance and the step cards. No bottom padding of
          its own; the pinned bar below supplies the gap under the last card. */}
      <div className="space-y-5 px-6 pt-4">
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
            // Anything you touch inside a card makes it the active one, the
            // arrows included: pressing up should leave the tint on the card
            // that moved, not on whatever took its place. Capture, so it still
            // registers on controls that stop the click themselves.
            <div
              key={s.id}
              ref={(el) => {
                // Dropped on unmount, so a deleted step doesn't leave its
                // detached card behind in the map.
                if (el) cardRefs.current.set(s.id, el);
                else cardRefs.current.delete(s.id);
              }}
              onClickCapture={() => setActiveStepId(s.id)}
            >
              {i > 0 && <StepConnector />}
              <StepEditor
                step={s}
                index={i}
                steps={f.steps}
                isStart={s.id === f.startStepId}
                isActive={s.id === activeStepId}
                collapsed={collapsed.has(s.id)}
                onToggleCollapsed={() => toggleCollapsed(s.id)}
                onChange={(next) => f.updateStep(i, next)}
                onAddStep={f.addStepReturningId}
                onJumpToStep={jumpToStep}
                onRemove={() => f.removeStep(i)}
                onMove={(dir) => f.moveStep(i, dir)}
              />
            </div>
          ))}
          {/* The scroll target for Add step. Inside the list, so it sits below
              the new card rather than below the buttons under it. */}
          <div ref={listEndRef} />
        </section>

        {/* Soft warnings: worth flagging, but they don't block saving. Said out
            loud, because an amber box next to a Save button otherwise reads as
            "you have done something wrong and cannot continue".

            Left in the flow rather than pinned with the buttons below. Nothing
            here stops you saving, so there is no moment where you press Save,
            nothing happens, and the reason is off screen; and pinning it would
            spend the one thing the pinned bar has to be careful with, which is
            height. */}
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
      </div>

      {/* Save and Cancel, pinned to the bottom of the scroll area, the way the
          name and the Steps toolbar are pinned to the top. A long sequence put
          them a long way down: the way to save an edit to step 2 was to scroll
          past step 20 to find the button.

          The blocking problems come with them, and only those. They are the
          answer to "why is Save greyed out", and leaving them in the flow meant
          the disabled button and the reason for it could not be on screen at
          the same time. They are capped and scroll inside their own box, so a
          skill with a dozen of them cannot take the pane over; the count in the
          heading says how many there are when the box cannot show them all. */}
      <div className="sticky bottom-0 z-10 space-y-2 border-t border-border/50 bg-background px-6 pb-4 pt-3">
        {f.problems.length > 0 && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            <p className="pb-1 font-medium">
              {f.problems.length === 1
                ? "One thing to fix before this can be saved:"
                : `${f.problems.length} things to fix before this can be saved:`}
            </p>
            <ul className="max-h-16 space-y-0.5 overflow-y-auto pr-1">
              {f.problems.map((p) => (
                <li key={p}>· {p}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Three, not two. Building a long sequence is a session's worth of
            work, and the only way to write it down used to be the button that
            also threw you back to the list: you saved by leaving, then went
            back in to carry on. Save now keeps you where you are. */}
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void save(false)}
            disabled={f.problems.length > 0}
            {...hint(
              savedId == null
                ? "Write this skill down and stay in the editor"
                : "Save your changes and stay in the editor",
            )}
          >
            Save
          </Button>
          <Button
            variant="outline"
            onClick={() => void save(true)}
            disabled={f.problems.length > 0}
            {...hint("Save, and go back to what you were looking at")}
          >
            Save and close
          </Button>
          <Button
            variant="outline"
            onClick={cancel}
            {...hint("Leave the editor. You'll be asked first if there is anything unsaved.")}
          >
            Cancel
          </Button>
          {savedId != null && !editing && (
            <span className="text-xs text-muted-foreground">
              Saved. Further saves update it.
            </span>
          )}
        </div>
      </div>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This editor has changes that have not been saved. Leaving now
              throws them away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={onCancel}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
