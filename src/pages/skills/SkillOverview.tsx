import { useEffect, useMemo, useRef, useState } from "react";
import {
  DownloadIcon,
  PencilIcon,
  PlayIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHint } from "@/lib/status";
import { NEXT, parseSequence, STOP, type Skill } from "@/lib/tauri/skills";
import { FlowMap } from "@/pages/skills/FlowMap";
import {
  buildFlowGraph,
  flowWarnings,
  branchTargets,
  stepDetail,
} from "@/pages/skills/flowGraph";

/** How a branch target reads in the detail panel. */
function targetLabel(target: string): string {
  if (target === STOP) return "finish the host";
  if (target === NEXT) return "the next step";
  return target;
}

/**
 * What you land on when you pick a skill: what it does, drawn as the branch
 * graph it actually is, with Edit one click further in.
 *
 * The step list in the builder is the right place to *change* a skill and the
 * wrong place to *understand* one, because the flow between steps is spread
 * across a column of dropdowns. This is the reading view. It changes nothing,
 * so it is also where the graph's two silent mistakes get surfaced: a step
 * nothing branches to, and a loop with no exit.
 */
export function SkillOverview({
  skill,
  canRun,
  onEdit,
  onRun,
  onExport,
  onClose,
}: {
  skill: Skill;
  /** False when no host is checked, or a run is already going. */
  canRun: boolean;
  onEdit: () => void;
  onRun: () => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const hint = useHint();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const config = useMemo(
    () => parseSequence(skill.config_json),
    [skill.config_json],
  );
  const graph = useMemo(
    () => buildFlowGraph(config.steps, config.startStepId),
    [config.steps, config.startStepId],
  );
  const warnings = useMemo(() => flowWarnings(graph), [graph]);
  const selected = config.steps.find((s) => s.id === selectedId) ?? null;
  const selectedIndex = config.steps.findIndex((s) => s.id === selectedId);

  // The map sizes itself to the window, so it needs to know how much room the
  // detail panel wants underneath it. Measured, because the panel's height
  // depends on the step: a `wait` has two lines, a branching `run` has six.
  const detailRef = useRef<HTMLElement>(null);
  const [detailHeight, setDetailHeight] = useState(0);
  useEffect(() => {
    const panel = detailRef.current;
    if (!panel) {
      setDetailHeight(0);
      return;
    }
    const observer = new ResizeObserver(() => {
      // Plus the gap the layout puts between the map and the panel.
      setDetailHeight(panel.offsetHeight + 20);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [selectedId]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{skill.name}</h2>
          {skill.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {skill.description}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {config.steps.length}{" "}
            {config.steps.length === 1 ? "step" : "steps"}
            {config.allowTransfer && " · keeps each shell open for handoff"}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          onClick={onClose}
          aria-label="Close"
          {...hint("Close this skill")}
        >
          <XIcon className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Hint on the wrapper, not the button: a disabled button emits no
            mouse events, and that's exactly when the reason matters. */}
        <span
          {...hint(
            canRun
              ? `Run "${skill.name}" on the checked hosts`
              : "Check at least one host on the left first",
          )}
        >
          <Button disabled={!canRun} onClick={onRun}>
            <PlayIcon className="mr-1.5 h-3.5 w-3.5" />
            Run
          </Button>
        </span>
        <Button variant="outline" onClick={onEdit} {...hint("Edit the steps")}>
          <PencilIcon className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
        <Button
          variant="outline"
          onClick={onExport}
          {...hint("Export to a .json file (definition only, no credentials)")}
        >
          <DownloadIcon className="mr-1.5 h-3.5 w-3.5" />
          Export
        </Button>
      </div>

      {config.params.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium">Inputs it asks for</h3>
          <ul className="space-y-1 rounded-md border border-border/60 p-2 text-xs">
            {config.params.map((p) => (
              <li key={p.key} className="flex flex-wrap items-baseline gap-2">
                <code className="rounded bg-muted px-1 font-mono">
                  {`{{${p.key}}}`}
                </code>
                <span className="text-muted-foreground">
                  {p.label || p.key}
                </span>
                {p.required && (
                  <span className="text-amber-600 dark:text-amber-400">
                    required
                  </span>
                )}
                {p.default && (
                  <span className="text-muted-foreground">
                    defaults to <code className="font-mono">{p.default}</code>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Problems the list view can't show you. Never blocking: a loop with an
          exit branch is a real pattern, and the engine caps runaway runs. */}
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-md border border-amber-300/70 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
          {warnings.map((w) => (
            <li key={w} className="flex gap-2">
              <TriangleAlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Flow</h3>
          <span className="text-xs text-purple-600 dark:text-purple-400">
            Click a step to see its settings
          </span>
        </div>
        <FlowMap
          steps={config.steps}
          startStepId={config.startStepId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          reserveBelow={selected ? detailHeight : 0}
        />
      </section>

      {selected && (
        <section
          ref={detailRef}
          className="space-y-2 rounded-md border border-border/60 p-3"
        >
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 font-mono text-xs">
              {selected.id}
            </code>
            <span className="text-sm">{stepDetail(selected)}</span>
          </div>
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {"timeoutSecs" in selected && selected.timeoutSecs != null && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Gives it</dt>
                <dd>{selected.timeoutSecs}s</dd>
              </div>
            )}
            {"onTimeout" in selected && selected.onTimeout && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">If time runs out</dt>
                <dd>
                  {selected.onTimeout === "pause"
                    ? "pause and wait for you"
                    : "fail the host"}
                </dd>
              </div>
            )}
            {selected.kind === "run" && selected.interactive && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Mode</dt>
                <dd>interactive (no completion marker)</dd>
              </div>
            )}
            {branchTargets(selected).map((b) => (
              <div key={b.label} className="flex gap-2">
                <dt className="text-muted-foreground">On {b.label}</dt>
                <dd>
                  {targetLabel(b.target)}
                  {b.target === NEXT && selectedIndex >= 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      (
                      {config.steps[selectedIndex + 1]?.id ??
                        "nothing follows, so it finishes"}
                      )
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
