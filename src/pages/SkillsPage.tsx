import { useCallback, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

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
import {
  exportSkill,
  parseSequence,
  readSkillFile,
  skillCloseRun,
  skillDetach,
  type Skill,
  type SkillInput,
  type SkillPane,
  type SkillPreflight,
} from "@/lib/tauri/skills";
import { errorMessage, type Host } from "@/lib/tauri/hosts";
import { railTooltip } from "@/lib/hostTags";
import { EmergencyCancel } from "@/pages/skills/EmergencyCancel";
import { takePaneSnapshot } from "@/pages/skills/paneSnapshots";
import { ParamForm } from "@/pages/skills/ParamForm";
import { RunPanel } from "@/pages/skills/RunPanel";
import { SequenceBuilder } from "@/pages/skills/SequenceBuilder";
import { SkillList } from "@/pages/skills/SkillList";
import { SkillOverview } from "@/pages/skills/SkillOverview";
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
  // Clicking a skill's name lands here, not in the editor: the flow map is how
  // you see what a skill actually does before you run or change it. The pencil
  // skips it and goes straight to `edit`.
  //
  // Held by id, not as a Skill: the overview must redraw when the skill it is
  // showing is saved, and a snapshot taken when the view opened cannot. Editing
  // a skill and saving left the map showing the pre-edit flow until you clicked
  // away and back.
  | { kind: "overview"; skillId: number }
  // `from` is where Cancel and a finished save return to, so the pencil's
  // "straight to the editor" route doesn't detour through a screen the operator
  // deliberately skipped.
  | { kind: "edit"; skill: Skill | null; from: "overview" | "list" }
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
export function SkillsPage({
  visible,
  onAdoptTerminal,
}: {
  visible: boolean;
  /** Hand a skill run's live shell to a terminal tab, adopting the exact
   * backend session. `snapshot` is the pane's scrollback as an ANSI string, so
   * the new tab opens with the run's history intact rather than empty. */
  onAdoptTerminal: (sessionId: string, host: Host, snapshot: string | null) => void;
}) {
  const hint = useHint();
  const sel = useSkillSelection(visible);
  const model = useSkillsModel();
  const run = useSkillRun();
  const [view, setView] = useState<View>({ kind: "idle" });
  /** The skill the live run belongs to. Held apart from `view` so wandering off
   * to build another skill doesn't lose track of what's running. */
  const [runningSkill, setRunningSkill] = useState<Skill | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
  /** The skill the overview is showing, resolved live from the model so a save
   * redraws it. Null when the view isn't the overview, or the skill is gone. */
  const overviewSkill =
    view.kind === "overview"
      ? model.skills.find((s) => s.id === view.skillId) ?? null
      : null;
  // A skill read from a file, awaiting the operator's confirmation to save.
  const [importing, setImporting] = useState<SkillInput | null>(null);
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

  // A root shell awaiting the "leaving a root shell open" confirm, and the
  // Close-run confirm when root shells are still open.
  const [pendingHandoff, setPendingHandoff] = useState<SkillPane | null>(null);
  const [pendingClose, setPendingClose] = useState(false);

  /** Whether the live run's skill permits handing shells to a terminal. */
  const runAllowsTransfer = runningSkill
    ? parseSequence(runningSkill.config_json).allowTransfer
    : false;
  /** Still-open shells that are root, once the run has finished. Only a
   * transfer-enabled skill keeps shells open, so a skill that doesn't allow
   * transfer never leaves one standing: its hosts' `isRoot` stays null (the
   * backend skips the probe) and this is 0, so Close run never warns. */
  const rootShellsOpen = runAllowsTransfer
    ? run.hosts.filter((h) => h.isRoot === true).length
    : 0;

  /** Hand one host's live shell to a terminal tab: detach the skill from that
   * host (its shell stays open), adopt the exact session, drop the pane. */
  const handoff = useCallback(
    async (pane: SkillPane) => {
      const host = sel.hosts.find((h) => h.id === pane.hostId);
      if (!host) {
        toast.error("That host is no longer listed; cannot open a terminal for it.");
        return;
      }
      if (!run.runId) return;
      // Grab the pane's scrollback before anything tears it down, so the new
      // terminal tab opens with the run's history, not an empty screen.
      const snapshot = takePaneSnapshot(pane.sessionId);
      try {
        await skillDetach(run.runId, pane.hostId);
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
      onAdoptTerminal(pane.sessionId, host, snapshot);
      run.removeHost(pane.hostId);
    },
    [sel.hosts, run, onAdoptTerminal],
  );

  /** From the run panel's per-host control: confirm first if the shell is root. */
  const requestHandoff = useCallback(
    (pane: SkillPane, isRoot: boolean) => {
      if (isRoot) setPendingHandoff(pane);
      else void handoff(pane);
    },
    [handoff],
  );

  /** Close a finished run: close any shells it still owns, then clear the panel. */
  const closeRun = useCallback(async () => {
    if (run.runId) {
      try {
        await skillCloseRun(run.runId);
      } catch (e) {
        toast.error(errorMessage(e));
      }
    }
    run.reset();
    setRunningSkill(null);
    setView({ kind: "idle" });
  }, [run]);

  /** Close run, confirming first if root shells are still open. */
  const requestCloseRun = useCallback(() => {
    if (rootShellsOpen > 0) setPendingClose(true);
    else void closeRun();
  }, [rootShellsOpen, closeRun]);

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

  const exportOne = useCallback(async (skill: Skill) => {
    try {
      const path = await saveDialog({
        title: "Export skill",
        defaultPath: `${skill.name.replace(/[^\w.-]+/g, "-")}.skill.json`,
        filters: [{ name: "Broadside skill", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await exportSkill(skill.id, path);
      toast.success(`Exported "${skill.name}"`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  const startImport = useCallback(async () => {
    try {
      const path = await openDialog({
        title: "Import skill",
        multiple: false,
        filters: [{ name: "Broadside skill", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      // Read and validate, but don't save yet: the operator previews the steps
      // first. Import is a normal create, so the guard still gates every run.
      setImporting(await readSkillFile(path));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

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
                <span className="min-w-0 truncate" title={railTooltip(h)}>
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
            view.kind === "overview"
              ? view.skillId
              : view.kind === "edit" || view.kind === "params"
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
          onOpen={(skill) => setView({ kind: "overview", skillId: skill.id })}
          onEdit={(skill) => setView({ kind: "edit", skill, from: "list" })}
          onNew={() => setView({ kind: "edit", skill: null, from: "list" })}
          onImport={startImport}
          onExport={exportOne}
          onDelete={setPendingDelete}
          onMove={(skill, direction) => void model.move(skill.id, direction)}
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
              visible={view.kind === "run"}
              allowTransfer={runAllowsTransfer}
              setTakenOver={run.setTakenOver}
              finishHost={run.finishHost}
              onSendToTerminal={requestHandoff}
              onDone={requestCloseRun}
            />
          </div>
        )}
        {view.kind === "overview" ? (
          // Looked up fresh on every render rather than carried in the view, so
          // saving an edit redraws the flow map immediately. Gone means it was
          // deleted from under us; the rail's empty state covers that.
          overviewSkill && (
            <SkillOverview
              skill={overviewSkill}
              canRun={sel.selected.size > 0 && !run.active}
              onEdit={() =>
                setView({
                  kind: "edit",
                  skill: overviewSkill,
                  from: "overview",
                })
              }
              onRun={() => setView({ kind: "params", skill: overviewSkill })}
              onExport={() => void exportOne(overviewSkill)}
              onClose={() => setView({ kind: "idle" })}
            />
          )
        ) : view.kind === "edit" ? (
          <SequenceBuilder
            editing={view.skill}
            onSave={model.save}
            // Leaving the editor (saved or cancelled) returns where it was
            // opened from: back to the flow map if that's where you came in,
            // and to the empty page if you took the pencil's shortcut past it.
            onCancel={() => {
              const id = view.skill?.id;
              setView(
                view.from === "overview" && id != null
                  ? { kind: "overview", skillId: id }
                  : { kind: "idle" },
              );
            }}
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

      {/* Import preview: show the steps before anything is saved. Import is a
          normal create, so the destructive guard and typed-CONFIRM gate still
          apply to every run of this skill. */}
      <AlertDialog
        open={importing != null}
        onOpenChange={(open) => {
          if (!open) setImporting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import "{importing?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This is someone else's skill. Look over its steps before you save
              it. Nothing runs until you choose to run it, and the destructive
              guard still applies then.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {importing && (
            <div className="space-y-2 text-xs">
              {importing.description && (
                <p className="text-muted-foreground">{importing.description}</p>
              )}
              <ol className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-2 font-mono">
                {parseSequence(importing.config_json).steps.map((s) => (
                  <li key={s.id} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">{s.id}</span>
                    <span className="min-w-0 break-all">
                      {s.kind === "run"
                        ? `run: ${s.command}`
                        : s.kind === "expect"
                          ? `wait for: ${s.pattern}${s.sendOnMatch ? ` then send ${JSON.stringify(s.sendOnMatch)}` : ""}`
                          : s.kind === "send"
                            ? `send: ${JSON.stringify(s.input)}`
                            : `wait ${s.seconds}s`}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                const input = importing;
                setImporting(null);
                if (input) void model.save(null, input);
              }}
            >
              Import
            </AlertDialogAction>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                if (pendingDelete) {
                  void model.remove(pendingDelete.id);
                  // Leave any view that was showing the skill we just deleted.
                  // Without this the overview looked up a skill that was gone
                  // and rendered nothing, leaving a blank panel.
                  if (
                    (view.kind === "overview" &&
                      view.skillId === pendingDelete.id) ||
                    ((view.kind === "edit" || view.kind === "params") &&
                      view.skill?.id === pendingDelete.id)
                  ) {
                    setView({ kind: "idle" });
                  }
                }
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Handing a root shell to a terminal leaves it open and privileged. */}
      <AlertDialog
        open={pendingHandoff != null}
        onOpenChange={(open) => {
          if (!open) setPendingHandoff(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send a root shell to a terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              This shell is running as root. Handing it to a terminal tab keeps
              it open with root privileges until you close that tab. Only do this
              if you mean to keep working as root.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                const pane = pendingHandoff;
                setPendingHandoff(null);
                if (pane) void handoff(pane);
              }}
            >
              Send to terminal
            </AlertDialogAction>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Closing a run closes any shells it left open, incl. root ones. */}
      <AlertDialog
        open={pendingClose}
        onOpenChange={(open) => {
          if (!open) setPendingClose(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close the run and its open shells?</AlertDialogTitle>
            <AlertDialogDescription>
              {rootShellsOpen === 1
                ? "1 shell is still open as root."
                : `${rootShellsOpen} shells are still open as root.`}{" "}
              Closing the run closes them. To keep one, send it to a terminal tab
              first instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setPendingClose(false);
                void closeRun();
              }}
            >
              Close run
            </AlertDialogAction>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
