import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NEXT,
  STOP,
  type LogLevel,
  type SeqStep,
  type TimeoutAction,
} from "@/lib/tauri/skills";
import { useHint } from "@/lib/status";
import { stepSummary } from "@/pages/skills/flowGraph";

/** Sentinel picked in a branch dropdown to spin up a fresh step and point the
 * branch at it. Not a real target; handled before it reaches state. */
const ADD_STEP = "add";

function TargetSelect({
  value,
  steps,
  selfId,
  index,
  onChange,
  onAddStep,
  onJumpToStep,
  label,
  hintText,
}: {
  value: string;
  steps: SeqStep[];
  selfId: string;
  /** Where this step sits in the list, so the dropdown knows what `next`
   * resolves to (the step below it, or stop when there is nothing below). */
  index: number;
  onChange: (v: string) => void;
  /** Creates a new step and returns its id, for the "add a new step" option. */
  onAddStep: () => string;
  /** Scrolls the editor to a step, for the jump button beside the dropdown. */
  onJumpToStep: (id: string) => void;
  label: string;
  hintText: string;
}) {
  const hint = useHint();
  const others = steps.filter((s) => s.id !== selfId).map((s) => s.id);
  const isLast = index === steps.length - 1;
  // The step this branch actually lands on, or null when it lands on nothing to
  // scroll to (stop, or a `next` with nothing below it).
  const target =
    value === STOP
      ? null
      : value === NEXT
        ? (steps[index + 1]?.id ?? null)
        : (steps.find((s) => s.id === value)?.id ?? null);
  return (
    <label className="flex items-center gap-1.5 text-xs" {...hint(hintText)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {/* No `flex-1` on the box below: it is only as wide as the longest thing
          it can say, which is why the wording is kept short. Two of these sit
          side by side in a half-width column, and a select clips its text
          rather than wrapping it, so a long option in a stretched box was
          being cut off. `min-w-0` lets it shrink (clipping again, but only
          when it must) rather than overflow the card on a narrow window. */}
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === ADD_STEP) onChange(onAddStep());
          else onChange(e.target.value);
        }}
        className="min-w-0 max-w-full rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
      >
        <option value={NEXT}>
          {isLast ? "next step (none yet)" : "next step below"}
        </option>
        {/* A step may loop back to itself (poll until ready); the cap stops a
            runaway, not this dropdown. */}
        <option value={selfId}>{selfId} (repeat)</option>
        {others.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        <option value={STOP}>stop this host</option>
        <option value={ADD_STEP}>+ add a step</option>
      </select>
      {/* Follow the branch. A dropdown reading `s7` says nothing about what s7
          does, and on a skill of any size s7 is somewhere off screen. */}
      {target && (
        <button
          type="button"
          onClick={() => onJumpToStep(target)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          aria-label={`Go to step ${target}`}
          {...hint(
            `Scroll to step ${target}${
              target === selfId ? " (this one)" : ""
            } and open it`,
          )}
        >
          <TargetIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </label>
  );
}

const KIND_LABEL: Record<SeqStep["kind"], string> = {
  run: "Run a command",
  expect: "Wait for output",
  send: "Send keys",
  wait: "Wait a set time",
  log: "Post to the skill log",
};

/** What each log level means, in the words the run log will use. */
const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  info: "Note",
  warn: "Warning",
  error: "Error",
};

/** One step's fields. The three kinds cover the whole vocabulary: run a command
 * and branch on it, wait for something and optionally answer it, or type keys. */
export function StepEditor({
  step,
  index,
  steps,
  isStart,
  isActive,
  collapsed,
  onToggleCollapsed,
  onChange,
  onAddStep,
  onJumpToStep,
  onRemove,
  onMove,
}: {
  step: SeqStep;
  index: number;
  steps: SeqStep[];
  isStart: boolean;
  /** The step last clicked on, tinted so it stays findable. Above all when it
   * moves: pressing the up arrow shifts a card a row at a time, and the tint is
   * what tells you which card just moved. */
  isActive: boolean;
  /** Folded down to its header, so a long skill reads as a list of steps rather
   * than a wall of fields. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChange: (step: SeqStep) => void;
  /** Creates a new step and returns its id, for the branch dropdowns. */
  onAddStep: () => string;
  /** Opens and scrolls to a step, for the button beside each branch. */
  onJumpToStep: (id: string) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const hint = useHint();

  const changeKind = (kind: SeqStep["kind"]) => {
    if (kind === step.kind) return;
    // New steps flow to the following step by default, so a linear skill just
    // works without touching branches.
    const base = { id: step.id };
    if (kind === "run")
      onChange({
        ...base,
        kind: "run",
        command: "",
        interactive: false,
        timeoutSecs: 60,
        onTimeout: "pause",
        onSuccess: NEXT,
        onFailure: STOP,
      });
    else if (kind === "expect")
      onChange({
        ...base,
        kind: "expect",
        pattern: "",
        sendOnMatch: "",
        timeoutSecs: 60,
        onTimeout: "pause",
        onMatch: NEXT,
      });
    else if (kind === "send")
      onChange({ ...base, kind: "send", input: "", next: NEXT });
    else if (kind === "log")
      onChange({ ...base, kind: "log", level: "info", message: "", next: NEXT });
    else onChange({ ...base, kind: "wait", seconds: 30, next: NEXT });
  };

  return (
    // Alternating tint + a thin light border so a long sequence reads as
    // distinct cards. A foreground overlay (not muted, which sits too close to
    // the page background to show) alternates a lifted card against the plain
    // page, so the stripe is actually visible in both themes.
    //
    // The active card overrides the stripe with a faint orange wash instead of
    // layering on top of it, so "which step am I on" reads the same wherever it
    // sits in the list, odd row or even. Orange rather than the accent blue
    // because the blue is already spoken for here (the "first" badge, focus
    // rings), and kept faint: this marks where you are, it is not a warning.
    <div
      className={`rounded border ${collapsed ? "" : "space-y-2 pb-3"} ${
        isActive
          ? "border-orange-400/60 bg-orange-400/[0.09] ring-1 ring-orange-400/25"
          : index % 2 === 0
            ? "border-white/15 bg-foreground/[0.07]"
            : "border-white/15 bg-transparent"
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {/* The whole left side of the header is the fold control: a collapsed
            card's one-liner is the biggest, most obvious target, and hunting
            for a chevron to reopen a step you just closed is needless work. */}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          className={`flex min-w-0 items-center gap-2 text-left ${collapsed ? "flex-1" : "shrink-0"}`}
          {...hint(
            collapsed
              ? `Open step ${step.id}`
              : `Fold step ${step.id} down to one line`,
          )}
        >
          {collapsed ? (
            <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {step.id}
          </code>
          {isStart && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              first
            </span>
          )}
          {/* Collapsed, the header has to carry what the fields would have
              said: what kind of step it is and what it actually does. */}
          {collapsed && (
            <>
              <span className="shrink-0 text-xs text-muted-foreground">
                {KIND_LABEL[step.kind]}
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
                {stepSummary(step)}
              </span>
            </>
          )}
        </button>
        {!collapsed && (
          <select
            value={step.kind}
            onChange={(e) => changeKind(e.target.value as SeqStep["kind"])}
            className="rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
            aria-label={`Step ${step.id} kind`}
          >
            {(Object.keys(KIND_LABEL) as SeqStep["kind"][]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label="Move step up"
          >
            <ChevronUpIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            disabled={index === steps.length - 1}
            onClick={() => onMove(1)}
            aria-label="Move step down"
          >
            <ChevronDownIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label="Delete step"
          >
            <Trash2Icon className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {!collapsed && step.kind === "run" && (
        <div className="space-y-2 px-3">
          <Input
            value={step.command}
            onChange={(e) => onChange({ ...step, command: e.target.value })}
            placeholder="apt update && DEBIAN_FRONTEND=noninteractive apt -y upgrade"
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
          />
          <label
            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
            {...hint(
              "For a command that never returns to the prompt, like sudo -i or one that stops on a question. Advances once output settles.",
            )}
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={step.interactive ?? false}
              onChange={(e) =>
                onChange({
                  ...step,
                  interactive: e.target.checked,
                  // An interactive step has no output boundary to test, so
                  // drop the match rather than leave it set but unreachable.
                  match: e.target.checked ? undefined : step.match,
                })
              }
            />
            Interactive (no exit code; use for sudo -i or a program that asks
            questions)
          </label>
          {/* An output test, for a command that reports what you care about in
              what it prints rather than in its exit code: `systemctl is-active`
              exits non-zero for both "inactive" and "no such unit", and plenty
              of tools exit 0 while printing the failure. Not offered on an
              interactive step, which has no output boundary to test. */}
          {!step.interactive && (
            <label
              className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
              {...hint(
                "Branch on what the command prints rather than its exit code. When on, this replaces the 'if it works' and 'if it fails' tests.",
              )}
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={step.match != null}
                onChange={(e) =>
                  onChange({
                    ...step,
                    // Seed the new branches from the exit-code ones, so turning
                    // this on keeps the flow you already wired rather than
                    // silently repointing both branches somewhere else.
                    match: e.target.checked
                      ? {
                          pattern: "",
                          ifMatch: step.onSuccess,
                          ifNoMatch: step.onFailure,
                        }
                      : undefined,
                  })
                }
              />
              Branch on what it prints, not its exit code
            </label>
          )}
          {step.interactive ? (
            <TargetSelect
              value={step.onSuccess}
              steps={steps}
              selfId={step.id}
              index={index}
              onAddStep={onAddStep}
              onJumpToStep={onJumpToStep}
              onChange={(v) => onChange({ ...step, onSuccess: v })}
              label="Then"
              hintText="Where to go once the command's output settles"
            />
          ) : step.match ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">
                  Take the match branch when the output contains (regular
                  expression)
                </Label>
                <Input
                  value={step.match.pattern}
                  onChange={(e) =>
                    onChange({
                      ...step,
                      match: { ...step.match!, pattern: e.target.value },
                    })
                  }
                  placeholder="^active$"
                  className="font-mono text-xs"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-[10px] text-muted-foreground">
                  ^ and $ mean the start and end of a line. The exit code is
                  ignored while this is on.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <TargetSelect
                  value={step.match.ifMatch}
                  steps={steps}
                  selfId={step.id}
                  index={index}
                  onAddStep={onAddStep}
                  onJumpToStep={onJumpToStep}
                  onChange={(v) =>
                    onChange({ ...step, match: { ...step.match!, ifMatch: v } })
                  }
                  label="If it matches"
                  hintText="Where to go when the output matches the pattern"
                />
                <TargetSelect
                  value={step.match.ifNoMatch}
                  steps={steps}
                  selfId={step.id}
                  index={index}
                  onAddStep={onAddStep}
                  onJumpToStep={onJumpToStep}
                  onChange={(v) =>
                    onChange({
                      ...step,
                      match: { ...step.match!, ifNoMatch: v },
                    })
                  }
                  label="If it doesn't"
                  hintText="Where to go when the output does not match the pattern"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <TargetSelect
                value={step.onSuccess}
                steps={steps}
                selfId={step.id}
                index={index}
                onAddStep={onAddStep}
                onJumpToStep={onJumpToStep}
                onChange={(v) => onChange({ ...step, onSuccess: v })}
                label="If it works"
                hintText="Where to go when the command exits 0"
              />
              <TargetSelect
                value={step.onFailure}
                steps={steps}
                selfId={step.id}
                index={index}
                onAddStep={onAddStep}
                onJumpToStep={onJumpToStep}
                onChange={(v) => onChange({ ...step, onFailure: v })}
                label="If it fails"
                hintText="Where to go when the command exits non-zero (e.g. 127 = not installed)"
              />
            </div>
          )}
          {!step.interactive && (
            <TimeoutFields
              timeoutSecs={step.timeoutSecs}
              onTimeout={step.onTimeout}
              onTimeoutTarget={step.onTimeoutTarget}
              onChange={(t) => onChange({ ...step, ...t })}
              failLabel="take the 'if it fails' branch"
              steps={steps}
              selfId={step.id}
              index={index}
              onAddStep={onAddStep}
              onJumpToStep={onJumpToStep}
            />
          )}
        </div>
      )}

      {!collapsed && step.kind === "expect" && (
        <div className="space-y-2 px-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Wait until the screen shows (regular expression)
            </Label>
            <Input
              value={step.pattern}
              onChange={(e) => onChange({ ...step, pattern: e.target.value })}
              placeholder="Do you want to continue\? \[Y/n\]"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[10px] text-muted-foreground">
              Matched against the terminal with colour and redraws stripped out.
              ^ and $ mean the start and end of a line.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Then type (leave empty to just wait)
            </Label>
            <Input
              value={step.sendOnMatch ?? ""}
              onChange={(e) =>
                onChange({ ...step, sendOnMatch: e.target.value })
              }
              placeholder="y\n"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[10px] text-muted-foreground">
              Use \n for Enter. Answering a (y/n) prompt is usually "y\n".
            </p>
          </div>
          <TargetSelect
            value={step.onMatch}
            steps={steps}
            selfId={step.id}
            index={index}
            onAddStep={onAddStep}
            onJumpToStep={onJumpToStep}
            onChange={(v) => onChange({ ...step, onMatch: v })}
            label="Then"
            hintText="Where to go once the pattern appears"
          />
          <TimeoutFields
            timeoutSecs={step.timeoutSecs}
            onTimeout={step.onTimeout}
            onTimeoutTarget={step.onTimeoutTarget}
            onChange={(t) => onChange({ ...step, ...t })}
            failLabel="fail this host"
            steps={steps}
            selfId={step.id}
            index={index}
            onAddStep={onAddStep}
            onJumpToStep={onJumpToStep}
          />
        </div>
      )}

      {!collapsed && step.kind === "send" && (
        <div className="space-y-2 px-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Type these keys, without waiting for anything
            </Label>
            <Input
              value={step.input}
              onChange={(e) => onChange({ ...step, input: e.target.value })}
              placeholder="q"
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[10px] text-muted-foreground">
              Use \n for Enter. A bare key like "q" dismisses a monitor that says
              "press any key".
            </p>
          </div>
          <TargetSelect
            value={step.next}
            steps={steps}
            selfId={step.id}
            index={index}
            onAddStep={onAddStep}
            onJumpToStep={onJumpToStep}
            onChange={(v) => onChange({ ...step, next: v })}
            label="Then"
            hintText="Where to go next"
          />
        </div>
      )}

      {!collapsed && step.kind === "wait" && (
        <div className="space-y-2 px-3">
          <label
            className="flex flex-wrap items-center gap-1.5 text-xs"
            {...hint(
              "Hold on the current screen for this long, sending nothing, then move on. An hour is the ceiling.",
            )}
          >
            <span className="shrink-0 text-muted-foreground">Wait</span>
            <Input
              type="number"
              min={1}
              max={3600}
              value={step.seconds}
              onChange={(e) =>
                onChange({
                  ...step,
                  seconds: Math.min(
                    3600,
                    Math.max(1, Number(e.target.value) || 30),
                  ),
                })
              }
              className="h-7 w-24 text-xs"
            />
            <span className="shrink-0 text-muted-foreground">
              seconds, doing nothing, then
            </span>
          </label>
          <p className="text-[10px] text-muted-foreground">
            The live screen keeps rendering while it waits. While it counts down
            you get a Continue now button to end the wait early, so this doubles
            as "wait up to N seconds, or until I say so". To dismiss a monitor
            when you continue, point Then at a Send-keys step (e.g. q) before
            stop.
          </p>
          <TargetSelect
            value={step.next}
            steps={steps}
            selfId={step.id}
            index={index}
            onAddStep={onAddStep}
            onJumpToStep={onJumpToStep}
            onChange={(v) => onChange({ ...step, next: v })}
            label="Then"
            hintText="Where to go once the wait is up"
          />
        </div>
      )}

      {!collapsed && step.kind === "log" && (
        <div className="space-y-2 px-3">
          <div className="flex flex-wrap items-end gap-2">
            <label
              className="flex items-center gap-1.5 text-xs"
              {...hint(
                "How loud this line is in the run log. An Error whose Then is 'stop' ends the host as a failure, carrying this message.",
              )}
            >
              <span className="shrink-0 text-muted-foreground">Log type</span>
              <select
                value={step.level}
                onChange={(e) =>
                  onChange({ ...step, level: e.target.value as LogLevel })
                }
                className="rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
              >
                {(Object.keys(LOG_LEVEL_LABEL) as LogLevel[]).map((l) => (
                  <option key={l} value={l}>
                    {LOG_LEVEL_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Message</Label>
            <Input
              value={step.message}
              onChange={(e) => onChange({ ...step, message: e.target.value })}
              placeholder="cancelled itself: this host is not a web server"
              className="text-xs"
              autoComplete="off"
            />
            <p className="text-[10px] text-muted-foreground">
              Goes to this host's run log only. Nothing is typed at the host and
              nothing on it is touched. Inputs work here:{" "}
              <code className="rounded bg-muted px-1">{"{{key}}"}</code>.
            </p>
          </div>
          <TargetSelect
            value={step.next}
            steps={steps}
            selfId={step.id}
            index={index}
            onAddStep={onAddStep}
            onJumpToStep={onJumpToStep}
            onChange={(v) => onChange({ ...step, next: v })}
            label="Then"
            hintText="Where to go after the line is posted"
          />
          {step.level === "error" &&
            (step.next === STOP ||
              (step.next === NEXT && index === steps.length - 1)) && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400">
                This ends the host as{" "}
                <span className="font-medium">failed</span>, with this message
                as the reason.
              </p>
            )}
        </div>
      )}
    </div>
  );
}

/** The timeout + what-to-do-about-it pair, shared by run and expect steps.
 *
 * Picking "go to a step" reveals the same target dropdown the branches use, so
 * a step that times out can take a recovery path. Before this, an `expect`
 * timeout could only fail the host or park waiting for someone. */
function TimeoutFields({
  timeoutSecs,
  onTimeout,
  onTimeoutTarget,
  onChange,
  failLabel,
  steps,
  selfId,
  index,
  onAddStep,
  onJumpToStep,
}: {
  timeoutSecs?: number;
  onTimeout?: TimeoutAction;
  onTimeoutTarget?: string;
  onChange: (t: {
    timeoutSecs: number;
    onTimeout: TimeoutAction;
    onTimeoutTarget?: string;
  }) => void;
  /** What "fail" does for this step kind, which differ. */
  failLabel: string;
  steps: SeqStep[];
  selfId: string;
  index: number;
  onAddStep: () => string;
  onJumpToStep: (id: string) => void;
}) {
  const hint = useHint();
  const secs = timeoutSecs ?? 60;
  const action = onTimeout ?? "pause";
  // Default a fresh goto to STOP rather than NEXT, matching the engine: a
  // timeout that falls through to the next step in the list is rarely what the
  // author means, and STOP at least ends the host cleanly.
  const target = onTimeoutTarget ?? STOP;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label
          className="flex items-center gap-1.5"
          {...hint(
            "How long to wait before giving up on this step. Raise it for long upgrades or prunes. An hour is the ceiling.",
          )}
        >
          <span className="shrink-0 text-muted-foreground">Wait up to</span>
          <Input
            type="number"
            min={1}
            max={3600}
            value={secs}
            onChange={(e) =>
              onChange({
                timeoutSecs: Math.min(3600, Math.max(1, Number(e.target.value) || 60)),
                onTimeout: action,
                onTimeoutTarget,
              })
            }
            className="h-7 w-20 text-xs"
          />
          <span className="shrink-0 text-muted-foreground">seconds, then</span>
        </label>
        <select
          value={action}
          onChange={(e) => {
            const next = e.target.value as TimeoutAction;
            onChange({
              timeoutSecs: secs,
              onTimeout: next,
              // Only carry a target while the action is "goto", so switching
              // away doesn't leave a stale edge behind in the saved config.
              onTimeoutTarget: next === "goto" ? target : undefined,
            });
          }}
          aria-label="On timeout"
          className="rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
        >
          <option value="pause">wait for me (recommended)</option>
          <option value="fail">{failLabel}</option>
          <option value="goto">go to a step</option>
        </select>
      </div>
      {action === "goto" && (
        <TargetSelect
          value={target}
          steps={steps}
          selfId={selfId}
          index={index}
          onAddStep={onAddStep}
          onJumpToStep={onJumpToStep}
          onChange={(v) =>
            onChange({ timeoutSecs: secs, onTimeout: "goto", onTimeoutTarget: v })
          }
          label="Go to"
          hintText="Where to carry on when this step runs out of time"
        />
      )}
    </div>
  );
}
