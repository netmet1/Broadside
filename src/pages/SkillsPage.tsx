import { useCallback, useState } from "react";

import { ConfirmDestructiveDialog } from "@/components/ConfirmDestructiveDialog";
import { RailFilterControls } from "@/components/RailFilterControls";
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
import { useHint, usePageStatus } from "@/lib/status";
import type { Skill, SkillPreflight } from "@/lib/tauri/skills";
import { EmergencyCancel } from "@/pages/skills/EmergencyCancel";
import { ParamForm } from "@/pages/skills/ParamForm";
import { RunPanel } from "@/pages/skills/RunPanel";
import { SequenceBuilder } from "@/pages/skills/SequenceBuilder";
import { SkillList } from "@/pages/skills/SkillList";
import {
  SKILL_SORT_OPTIONS,
  useSkillSelection,
} from "@/pages/skills/useSkillSelection";
import { useSkillRun } from "@/pages/skills/useSkillRun";
import { useSkillsModel } from "@/pages/skills/useSkillsModel";

/** What the main panel is showing. The run is deliberately not carried here:
 * it outlives whatever you happen to be looking at, so it lives in its own
 * state and this only decides whether it is the thing on screen. */
type View =
  | { kind: "idle" }
  | { kind: "edit"; skill: Skill | null }
  | { kind: "params"; skill: Skill }
  | { kind: "run" };

/**
 * Skills: reusable multi-step operations that open a live shell on each checked
 * host and drive it (running commands, watching for prompts, answering them)
 * while the operator watches the real terminal.
 *
 * A thin shell: the rail is host selection + the skill list, the main panel is
 * whichever of build / configure / watch the user is in. All logic lives in
 * `src/pages/skills/`.
 */
export function SkillsPage({ visible }: { visible: boolean }) {
  const hint = useHint();
  const sel = useSkillSelection(visible);
  const model = useSkillsModel();
  const run = useSkillRun();
  const [view, setView] = useState<View>({ kind: "idle" });
  /** The skill the live run belongs to. Held apart from `view` so wandering off
   * to build another skill doesn't lose track of what's running. */
  const [runningSkill, setRunningSkill] = useState<Skill | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
  // Set when a run needs the typed-CONFIRM gate (D-014).
  const [confirming, setConfirming] = useState<{
    skill: Skill;
    params: Record<string, string>;
    preflight: SkillPreflight;
  } | null>(null);

  usePageStatus(
    run.active
      ? `Running ${run.hosts.length === 1 ? "1 host" : `${run.hosts.length} hosts`}`
      : sel.hosts.length > 0
        ? `${sel.selected.size}/${sel.visibleHosts.length} hosts selected`
        : null,
    visible,
  );

  const dispatch = useCallback(
    async (
      skill: Skill,
      params: Record<string, string>,
      confirmed: boolean,
    ) => {
      const ok = await run.start({
        skillId: skill.id,
        hostIds: sel.selectedHosts.map((h) => h.id),
        params,
        confirmed,
        // A generous default size: the panes fit themselves on mount, and a
        // too-narrow PTY would wrap the shell's echo mid-command.
        cols: 120,
        rows: 32,
      });
      if (ok) {
        setRunningSkill(skill);
        setView({ kind: "run" });
      }
    },
    [run, sel.selectedHosts],
  );

  const startRun = useCallback(
    (
      skill: Skill,
      params: Record<string, string>,
      preflight: SkillPreflight,
    ) => {
      // Destructive steps get the same typed-CONFIRM gate as a broadcast. The
      // backend re-checks and refuses an unconfirmed hit regardless; this is
      // the UX half.
      if (preflight.matchedRules.length > 0) {
        setConfirming({ skill, params, preflight });
        return;
      }
      void dispatch(skill, params, false);
    },
    [dispatch],
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Rail: hosts on top, skills below. */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border/50">
        <div className="shrink-0 px-3 py-2">
          <label
            className="flex cursor-pointer items-center gap-2 text-sm font-medium"
            {...hint("Select or deselect every listed host")}
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={sel.allSelected}
              onChange={sel.toggleAll}
              disabled={run.active || sel.visibleHosts.length === 0}
            />
            Select all
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {sel.selected.size}/{sel.visibleHosts.length}
            </span>
          </label>
        </div>
        <div className="shrink-0 px-3 pb-2">
          <select
            value={sel.railSort}
            onChange={(e) => sel.setRailSort(e.target.value)}
            aria-label="Sort hosts"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground outline-none focus-visible:border-ring"
          >
            {SKILL_SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                Sort: {o.label}
              </option>
            ))}
          </select>
        </div>
        <RailFilterControls f={sel.filter} />
        <div className="max-h-[40%] min-h-0 flex-1 overflow-y-auto p-2">
          {sel.hosts.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              No saved hosts. Add one on the Hosts page first.
            </p>
          ) : (
            sel.visibleHosts.map((h) => (
              <label
                key={h.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={sel.selected.has(h.id)}
                  onChange={() => sel.toggleHost(h.id)}
                  disabled={run.active}
                />
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: h.color }}
                />
                <span className="min-w-0 truncate" title={h.label}>
                  {h.label}
                </span>
              </label>
            ))
          )}
          {sel.hosts.length > 0 &&
            sel.visibleHosts.length === 0 &&
            sel.filter.filterActive && (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No hosts match the current filter.
              </p>
            )}
        </div>

        <SkillList
          skills={model.skills}
          loading={model.loading}
          selectedId={
            view.kind === "edit" || view.kind === "params"
              ? view.skill?.id ?? null
              : view.kind === "run"
                ? runningSkill?.id ?? null
                : null
          }
          runningSkillId={run.runId ? (runningSkill?.id ?? null) : null}
          watching={view.kind === "run"}
          canRun={sel.selected.size > 0 && !run.active}
          onRun={(skill) => setView({ kind: "params", skill })}
          onWatch={() => setView({ kind: "run" })}
          onEdit={(skill) => setView({ kind: "edit", skill })}
          onNew={() => setView({ kind: "edit", skill: null })}
          onDelete={setPendingDelete}
        />

        {/* Emergency stop lives here, ghosted until a run is live. */}
        <div className="shrink-0 border-t border-border/50 p-2">
          <EmergencyCancel active={run.active} onCancel={run.cancelAll} />
        </div>
      </div>

      {/* Main panel. */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {/* The run panel stays mounted for as long as the run exists, and is
            only hidden when you look at something else. Swapping it out
            destroys the xterm panes with it: the run itself would carry on
            (the backend owns those PTYs) but its scrollback would be gone and
            there would be no way back to it. The eye button on the rail brings
            it forward again. */}
        {run.runId && runningSkill && (
          <div className={view.kind === "run" ? "block h-full" : "hidden"}>
            <RunPanel
              runId={run.runId}
              hosts={run.hosts}
              skillName={runningSkill.name}
              active={run.active}
              setTakenOver={run.setTakenOver}
              onDone={() => {
                run.reset();
                setRunningSkill(null);
                setView({ kind: "idle" });
              }}
            />
          </div>
        )}
        {view.kind === "edit" ? (
          <SequenceBuilder
            editing={view.skill}
            onSave={model.save}
            onCancel={() => setView({ kind: "idle" })}
          />
        ) : view.kind === "params" ? (
          <ParamForm
            skill={view.skill}
            hosts={sel.selectedHosts}
            starting={run.starting}
            onCancel={() => setView({ kind: "idle" })}
            onRun={(params, preflight) => startRun(view.skill, params, preflight)}
          />
        ) : view.kind === "idle" ? (
          <div className="mx-auto max-w-lg px-6 py-16 text-center">
            <h2 className="text-lg font-semibold">Skills</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              A skill opens a live shell on each host you check and drives it:
              running commands, waiting for prompts, and answering them. Because
              it's a real shell, it can become root and stay root, work through
              questions, and handle programs that repaint the screen, and you
              watch every host's terminal while it happens.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              Check some hosts on the left, then press play on a skill.
            </p>
          </div>
        ) : null}
      </div>

      {confirming && (
        <ConfirmDestructiveDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          command={confirming.skill.name}
          hits={confirming.preflight.matchedRules}
          hostLabels={sel.selectedHosts.map((h) => h.label).sort()}
          onConfirmed={() => {
            const c = confirming;
            setConfirming(null);
            void dispatch(c.skill, c.params, true);
          }}
        />
      )}

      <AlertDialog
        open={pendingDelete != null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this skill?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pendingDelete?.name}" will be removed. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) void model.remove(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
