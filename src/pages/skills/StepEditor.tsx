import { ChevronDownIcon, ChevronUpIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NEXT, STOP, type SeqStep } from "@/lib/tauri/skills";
import { useHint } from "@/lib/status";

/** Sentinel picked in a branch dropdown to spin up a fresh step and point the
 * branch at it. Not a real target; handled before it reaches state. */
const ADD_STEP = "add";

function TargetSelect({
  value,
  steps,
  selfId,
  isLast,
  onChange,
  onAddStep,
  label,
  hintText,
}: {
  value: string;
  steps: SeqStep[];
  selfId: string;
  /** This step is last in the list, so `next` would resolve to stop. */
  isLast: boolean;
  onChange: (v: string) => void;
  /** Creates a new step and returns its id, for the "add a new step" option. */
  onAddStep: () => string;
  label: string;
  hintText: string;
}) {
  const hint = useHint();
  const others = steps.filter((s) => s.id !== selfId).map((s) => s.id);
  return (
    <label className="flex items-center gap-1.5 text-xs" {...hint(hintText)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === ADD_STEP) onChange(onAddStep());
          else onChange(e.target.value);
        }}
        className="min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
      >
        <option value={NEXT}>
          {isLast
            ? "continue to next step (none after this yet)"
            : "continue to next step"}
        </option>
        {/* A step may loop back to itself (poll until ready); the cap stops a
            runaway, not this dropdown. */}
        <option value={selfId}>{selfId} (repeat this step)</option>
        {others.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
        <option value={STOP}>stop (finish this host)</option>
        <option value={ADD_STEP}>+ add a new step</option>
      </select>
    </label>
  );
}

const KIND_LABEL: Record<SeqStep["kind"], string> = {
  run: "Run a command",
  expect: "Wait for output",
  send: "Send keys",
  wait: "Wait a set time",
};

/** One step's fields. The three kinds cover the whole vocabulary: run a command
 * and branch on it, wait for something and optionally answer it, or type keys. */
export function StepEditor({
  step,
  index,
  steps,
  isStart,
  onChange,
  onAddStep,
  onRemove,
  onMove,
}: {
  step: SeqStep;
  index: number;
  steps: SeqStep[];
  isStart: boolean;
  onChange: (step: SeqStep) => void;
  /** Creates a new step and returns its id, for the branch dropdowns. */
  onAddStep: () => string;
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
    else onChange({ ...base, kind: "wait", seconds: 30, next: NEXT });
  };

  return (
    // Alternating tint + a thin light border so a long sequence reads as
    // distinct cards. A foreground overlay (not muted, which sits too close to
    // the page background to show) alternates a lifted card against the plain
    // page, so the stripe is actually visible in both themes.
    <div
      className={`space-y-2 rounded border border-white/15 p-3 ${
        index % 2 === 0 ? "bg-foreground/[0.07]" : "bg-transparent"
      }`}
    >
      <div className="flex items-center gap-2">
        <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {step.id}
        </code>
        {isStart && (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            first
          </span>
        )}
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

      {step.kind === "run" && (
        <div className="space-y-2">
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
              "For a command that never returns to the prompt on its own. sudo -i opens a nested shell, an interactive program stops on a question. A sudo password prompt is answered automatically from the host's stored sudo password. The step advances once output settles; drive the rest with Wait-for-output steps.",
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
                "Branch on what the command prints instead of its exit code. The test wins over the exit code when it's on, so the 'if it works' and 'if it fails' branches are replaced. Matched against the command's output only, not its echoed command line.",
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
              isLast={index === steps.length - 1}
              onAddStep={onAddStep}
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
                  isLast={index === steps.length - 1}
                  onAddStep={onAddStep}
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
                  isLast={index === steps.length - 1}
                  onAddStep={onAddStep}
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
              isLast={index === steps.length - 1}
              onAddStep={onAddStep}
                onChange={(v) => onChange({ ...step, onSuccess: v })}
                label="If it works"
                hintText="Where to go when the command exits 0"
              />
              <TargetSelect
                value={step.onFailure}
                steps={steps}
                selfId={step.id}
              isLast={index === steps.length - 1}
              onAddStep={onAddStep}
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
              onChange={(t) => onChange({ ...step, ...t })}
              failLabel="take the 'if it fails' branch"
            />
          )}
        </div>
      )}

      {step.kind === "expect" && (
        <div className="space-y-2">
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
            isLast={index === steps.length - 1}
            onAddStep={onAddStep}
            onChange={(v) => onChange({ ...step, onMatch: v })}
            label="Then"
            hintText="Where to go once the pattern appears"
          />
          <TimeoutFields
            timeoutSecs={step.timeoutSecs}
            onTimeout={step.onTimeout}
            onChange={(t) => onChange({ ...step, ...t })}
            failLabel="fail this host"
          />
        </div>
      )}

      {step.kind === "send" && (
        <div className="space-y-2">
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
            isLast={index === steps.length - 1}
            onAddStep={onAddStep}
            onChange={(v) => onChange({ ...step, next: v })}
            label="Then"
            hintText="Where to go next"
          />
        </div>
      )}

      {step.kind === "wait" && (
        <div className="space-y-2">
          <label
            className="flex flex-wrap items-center gap-1.5 text-xs"
            {...hint(
              "Hold on the current screen for this long, sending nothing, then move on. Good for letting a redrawing status screen keep running before the skill finishes. An hour is the ceiling.",
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
            isLast={index === steps.length - 1}
            onAddStep={onAddStep}
            onChange={(v) => onChange({ ...step, next: v })}
            label="Then"
            hintText="Where to go once the wait is up"
          />
        </div>
      )}
    </div>
  );
}

/** The timeout + what-to-do-about-it pair, shared by run and expect steps. */
function TimeoutFields({
  timeoutSecs,
  onTimeout,
  onChange,
  failLabel,
}: {
  timeoutSecs?: number;
  onTimeout?: "fail" | "pause";
  onChange: (t: { timeoutSecs: number; onTimeout: "fail" | "pause" }) => void;
  /** What "fail" does for this step kind, which differ. */
  failLabel: string;
}) {
  const hint = useHint();
  const secs = timeoutSecs ?? 60;
  const action = onTimeout ?? "pause";
  return (
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
            })
          }
          className="h-7 w-20 text-xs"
        />
        <span className="shrink-0 text-muted-foreground">seconds, then</span>
      </label>
      <select
        value={action}
        onChange={(e) =>
          onChange({
            timeoutSecs: secs,
            onTimeout: e.target.value as "fail" | "pause",
          })
        }
        aria-label="On timeout"
        className="rounded-md border border-input bg-background px-1.5 py-1 text-xs outline-none focus-visible:border-ring"
      >
        <option value="pause">wait for me (recommended)</option>
        <option value="fail">{failLabel}</option>
      </select>
    </div>
  );
}
