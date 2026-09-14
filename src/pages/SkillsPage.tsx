import { useCallback, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  WandSparklesIcon,
} from "lucide-react";
import { toast } from "sonner";

import { ConfirmDestructiveDialog } from "@/components/ConfirmDestructiveDialog";
import { EmptyState } from "@/components/EmptyState";
import { RailFilterControls } from "@/components/RailFilterControls";
import { ShellChip } from "@/components/ShellChip";
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
import { cn } from "@/lib/utils";
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
import { stepDetail } from "@/pages/skills/flowGraph";
import { takePaneSnapshot } from "@/pages/skills/paneSnapshots";
import { ParamForm } from "@/pages/skills/ParamForm";
import { RunPanel } from "@/pages/skills/RunPanel";
import { SequenceBuilder } from "@/pages/skills/SequenceBuilder";
import { SkillList } from "@/pages/skills/SkillList";
import { SkillOverview } from "@/pages/skills/SkillOverview";
import {
  NODE_STATUS_ORDER,
  NODE_STATUS_STYLE,
} from "@/pages/skills/useNodeStatus";
import {
  SKILL_SORT_OPTIONS,
  useSkillSelection,
} from "@/pages/skills/useSkillSelection";
import { useSkillRun } from "@/pages/skills/useSkillRun";
import { useSkillsModel } from "@/pages/skills/useSkillsModel";
import type { SkillDraft } from "@/pages/skills/useSequenceForm";
import { HELP_SKILLS, type HelpSectionId } from "@/pages/help/sections";

/** Persisted collapse state for the whole rail. */
const RAIL_COLLAPSED_KEY = "skills-rail-collapsed";

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
  //
  // `template` seeds a new skill from an existing one (Clone). It is only ever
  // set with `skill: null`: the copy is unsaved until Create, so cancelling one
  // leaves the original alone.
  | {
      kind: "edit";
      skill: Skill | null;
      template?: SkillDraft | null;
      from: "overview" | "list";
    }
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
  connectedHostIds,
  onAdoptTerminal,
  onOpenHelp,
}: {
  visible: boolean;
  /** Hosts with a connected terminal open. The strongest thing the rail's
   * status dot can say: you are already at that machine. */
  connectedHostIds: Set<number>;
  /** Hand a skill run's live shell to a terminal tab, adopting the exact
   * backend session. `snapshot` is the pane's scrollback as an ANSI string, so
   * the new tab opens with the run's history intact rather than empty. */
  onAdoptTerminal: (sessionId: string, host: Host, snapshot: string | null) => void;
  /** Open the Help tab at a section, from the empty state's link. */
  onOpenHelp: (section: HelpSectionId) => void;
}) {
  const hint = useHint();
  const sel = useSkillSelection(visible, connectedHostIds);
  // Collapsible rail, persisted. The whole rail, hosts and skills together:
  // there is no dot-and-initials view of a skill worth keeping, so this is the
  // plain kind of collapse, out of the way and back again.
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_COLLAPSED_KEY) === "1",
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(RAIL_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }, []);
  const model = useSkillsModel();
  const run = useSkillRun();
  const [view, setView] = useState<View>({ kind: "idle" });
  /** The skill the live run belongs to. Held apart from `view` so wandering off
   * to build another skill doesn't lose track of what's running. */
  const [runningSkill, setRunningSkill] = useState<Skill | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
  /** Whether run panes open with their step log showing. Lives here, above the
   * run, so a rerun (which builds new panes) keeps the log you had open. */
  const [runLogOpen, setRunLogOpen] = useState(false);
  /** Bumped every time the editor is opened, and used as its React key, so each
   * visit builds a fresh form. The editor seeds its fields once on mount, so
   * without this, going from one skill straight to another (or to New) kept the
   * previous skill's steps in the fields under the new heading, and saving then
   * wrote them onto the wrong skill. */
  const [editNonce, setEditNonce] = useState(0);
  /** The one way into the editor, so nothing can open it without a fresh key. */
  const openEditor = useCallback(
    (v: { skill: Skill | null; template?: SkillDraft | null; from: "overview" | "list" }) => {
      setEditNonce((n) => n + 1);
      setView({ kind: "edit", ...v });
    },
    [],
  );
  /** Clone: open the editor as a *new* skill seeded from this one. Nothing is
   * written until Create, so the original is untouched either way. */
  const cloneSkill = useCallback(
    (skill: Skill, from: "overview" | "list") =>
      openEditor({
        skill: null,
        template: {
          name: `${skill.name} (clone)`,
          description: `Clone of ${skill.name}`,
          config_json: skill.config_json,
        },
        from,
      }),
    [openEditor],
  );
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
  /** Where to land once the "this closes root shells" confirm is answered, and
   * null when it isn't open. Held as the destination rather than a flag so
   * Rerun keeps its intent through the dialog instead of dropping you on the
   * empty page. */
  const [pendingClose, setPendingClose] = useState<View | null>(null);

  /**
   * What the rail says beside the skill that has a run: whether it is still
   * going, and if not, how it ended.
   *
   * Read from the hosts, not from `run.runId`. A run id is set the moment a run
   * starts and cleared only when the operator clears the run, so it answers
   * "is there a run here", which is a different question from "is it still
   * going". Deriving the badge from it left the rail saying `running` in green
   * after every host had already finished or failed, with the panel beside it
   * showing three red outlines.
   *
   * `failed` if any host failed, because that is the outcome someone needs to
   * be told about and a run that half worked is not a run that worked. Paused
   * counts as running: the engine is parked waiting for a person, which is a
   * run that still has somewhere to go.
   */
  const runStatus: "running" | "done" | "failed" | null =
    run.hosts.length === 0
      ? null
      : run.active
        ? "running"
        : run.hosts.some((h) => h.status === "failed")
          ? "failed"
          : "done";
  const runState =
    runStatus !== null && runningSkill
      ? { skillId: runningSkill.id, status: runStatus }
      : null;

  /** Whether the live run's skill permits handing shells to a terminal. */
  const runAllowsTransfer = runningSkill
    ? parseSequence(runningSkill.config_json).allowTransfer
    : false;
  /** The live run's skill has no repeat cap, so it cannot end itself if it
   * loops. The panel says so, because that is where Stop host is. */
  const runUncapped = runningSkill
    ? parseSequence(runningSkill.config_json).unlimitedStepRepeats === true
    : false;
  /** The running skill's steps in list order, so each pane can say which step
   * of how many it is on. Read from the skill the run started with, not from
   * the rail: editing the skill mid-run must not renumber a live run's panes. */
  const runStepIds = useMemo(
    () =>
      runningSkill
        ? parseSequence(runningSkill.config_json).steps.map((s) => s.id)
        : [],
    [runningSkill],
  );
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

  /** Close a finished run: close any shells it still owns, then clear the panel.
   * `then` is where to land afterwards, so Rerun can go straight to the same
   * skill's confirmation instead of the empty page. */
  const closeRun = useCallback(
    async (then?: View) => {
      if (run.runId) {
        try {
          await skillCloseRun(run.runId);
        } catch (e) {
          toast.error(errorMessage(e));
        }
      }
      run.reset();
      setRunningSkill(null);
      setView(then ?? { kind: "idle" });
    },
    [run],
  );

  /** Close run, confirming first if root shells are still open. */
  const requestCloseRun = useCallback(() => {
    if (rootShellsOpen > 0) setPendingClose({ kind: "idle" });
    else void closeRun();
  }, [rootShellsOpen, closeRun]);

  /** Run the same skill again: close this run (its shells included) and go back
   * to the confirmation, so the hosts and inputs are checked rather than
   * silently reused. Nothing is dispatched from here. */
  const rerun = useCallback(() => {
    const skill = runningSkill;
    if (!skill) return;
    // Same rule as Close run: shells left open as root are not closed silently.
    if (rootShellsOpen > 0) {
      setPendingClose({ kind: "params", skill });
      return;
    }
    void closeRun({ kind: "params", skill });
  }, [runningSkill, rootShellsOpen, closeRun]);

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

  /**
   * The main panel with nothing open in it, and what a view falls back to when
   * the skill it was showing has gone.
   *
   * It always carries New and Import, not only while the list is empty. The
   * rail holds the other copy of both, and the rail can be collapsed: a page
   * with a skill saved and the rail put away used to show a paragraph pointing
   * "on the left" at a rail that was not there, and nothing on screen that
   * made a skill. Blank while the list loads, so the button does not read "New
   * skill" for a frame and then change its mind.
   */
  const noSkills = model.skills.length === 0;
  const idlePanel = model.loading ? null : (
    <EmptyState
      icon={WandSparklesIcon}
      title="Skills"
      actionLabel={noSkills ? "Create your first skill" : "New skill"}
      onAction={() => openEditor({ skill: null, from: "list" })}
      actionHint="Build a skill: a sequence of steps run over a live shell on each checked host"
      secondaryLabel="Import"
      onSecondary={() => void startImport()}
      secondaryHint="Import a skill from a .json file. You'll see its steps before it's saved."
      description={
        noSkills ? (
          "A skill opens a live shell on each host you check and drives it: running commands, waiting for prompts, and answering them. You watch every host's terminal while it happens."
        ) : (
          <>
            A skill opens a live shell on each host you check and drives it:
            running commands, waiting for prompts, and answering them. Because
            it's a real shell, it can become root and stay root, work through
            questions, and handle programs that repaint the screen, and you
            watch every host's terminal while it happens.
            {/* Amber while the rail is put away: it is the one step the
                operator can't see a way to take, so it has to stand out. */}
            <span
              className={cn(
                "mt-3 block",
                railCollapsed && "font-medium text-amber-600 dark:text-amber-400",
              )}
            >
              {railCollapsed
                ? "Open the rail on the left, check some hosts, then press play on a skill."
                : "Check some hosts on the left, then press play on a skill."}
            </span>
          </>
        )
      }
      helpSection={HELP_SKILLS}
      onOpenHelp={onOpenHelp}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      {/* Collapsed: nothing but the way back. Deliberately not a dot-and-
          initials view like the terminal rails have; there is no useful
          two-character form of a skill, and the ask was for the space. */}
      {railCollapsed && (
        <div className="flex w-9 shrink-0 flex-col items-center border-r border-border/50 py-2">
          <button
            type="button"
            onClick={toggleRail}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            aria-label="Expand the rail"
            {...hint("Bring back the host and skill rail")}
          >
            <PanelLeftOpenIcon className="h-4 w-4" />
          </button>
        </div>
      )}
      {/* Rail: hosts on top, skills below. */}
      <div
        className={`w-64 shrink-0 flex-col border-r border-border/50 ${
          railCollapsed ? "hidden" : "flex"
        }`}
      >
        <div className="flex shrink-0 items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={toggleRail}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            aria-label="Collapse the rail"
            {...hint("Collapse the host and skill rail out of the way")}
          >
            <PanelLeftCloseIcon className="h-4 w-4" />
          </button>
          <label
            className="flex flex-1 cursor-pointer items-center gap-2 text-sm font-medium"
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
                {/* Marked, never filtered (D-067). A host that cannot run a
                    skill still says so here rather than vanishing from the
                    list, and the run refuses it by name when it starts. */}
                <ShellChip
                  compact
                  capability={h.shell_capability}
                  loginShell={h.login_shell}
                  pref={h.shell_integration}
                />
                {/* Five states, not two, and the legend below says which is
                    which. A skill opens its own shell on each checked host, so
                    "can this machine be reached at all" is the question worth
                    answering before you press play rather than after. */}
                <span
                  className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                    NODE_STATUS_STYLE[sel.status.get(h.id) ?? "checking"].dot
                  }`}
                  title={
                    NODE_STATUS_STYLE[sel.status.get(h.id) ?? "checking"].title
                  }
                />
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

        {/* What the dots mean. Five colours nobody was born knowing, on a page
            where getting one wrong means running a sequence against a machine
            that is not there, so the key is on screen rather than in the help.
            Two columns of very small type: it has to be readable without being
            the thing you look at. */}
        {sel.hosts.length > 0 && (
          <div className="grid shrink-0 grid-cols-2 gap-x-2 gap-y-0.5 border-t border-border/50 px-3 py-1.5 text-[10px] leading-tight text-muted-foreground">
            {NODE_STATUS_ORDER.map((s) => (
              <span
                key={s}
                className="flex items-center gap-1.5"
                title={NODE_STATUS_STYLE[s].title}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${NODE_STATUS_STYLE[s].dot}`}
                />
                <span className="truncate">{NODE_STATUS_STYLE[s].label}</span>
              </span>
            ))}
          </div>
        )}

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
          runState={runState}
          watching={view.kind === "run"}
          canRun={sel.selected.size > 0 && !run.active}
          onRun={(skill) => setView({ kind: "params", skill })}
          onWatch={() => setView({ kind: "run" })}
          onOpen={(skill) => setView({ kind: "overview", skillId: skill.id })}
          onEdit={(skill) => openEditor({ skill, from: "list" })}
          onNew={() => openEditor({ skill: null, from: "list" })}
          onClone={(skill) => cloneSkill(skill, "list")}
          onImport={startImport}
          onExport={exportOne}
          onDelete={setPendingDelete}
          onSwap={(a, b) => void model.swap(a.id, b.id)}
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
              stepIds={runStepIds}
              active={run.active}
              allowTransfer={runAllowsTransfer}
              uncapped={runUncapped}
              setTakenOver={run.setTakenOver}
              requestTakeOver={run.requestTakeOver}
              finishHost={run.finishHost}
              onSendToTerminal={requestHandoff}
              onDone={requestCloseRun}
              onRerun={rerun}
              logOpen={runLogOpen}
              onLogOpenChange={setRunLogOpen}
            />
          </div>
        )}
        {view.kind === "overview" ? (
          // Looked up fresh on every render rather than carried in the view, so
          // saving an edit redraws the flow map immediately. Gone means it was
          // deleted from under us, and then this is the empty panel rather than
          // nothing: the rail may be collapsed, and its "No skills yet." has no
          // button of its own.
          overviewSkill ? (
            <SkillOverview
              skill={overviewSkill}
              canRun={sel.selected.size > 0 && !run.active}
              onEdit={() =>
                openEditor({ skill: overviewSkill, from: "overview" })
              }
              onClone={() => cloneSkill(overviewSkill, "overview")}
              onRun={() => setView({ kind: "params", skill: overviewSkill })}
              onExport={() => void exportOne(overviewSkill)}
              onClose={() => setView({ kind: "idle" })}
            />
          ) : (
            idlePanel
          )
        ) : view.kind === "edit" ? (
          <SequenceBuilder
            // Keyed, so switching what is being edited rebuilds the form.
            // Without this, React keeps the mounted editor and its state: New
            // opened with the previous skill's steps still in the fields, and
            // the pencil on a second skill showed the first one's steps under
            // the second one's name, so saving wrote them onto the wrong skill.
            key={editNonce}
            editing={view.skill}
            template={view.template}
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
          // Nothing open: the same centred block Hosts and Templates show, with
          // the text under it depending on whether there are skills to run.
          idlePanel
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
                    {/* The same full-length description the flow map's detail
                        panel uses, so a new step kind is described here without
                        this list having to learn about it. */}
                    <span className="min-w-0 break-all">{stepDetail(s)}</span>
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
        open={pendingClose != null}
        onOpenChange={(open) => {
          if (!open) setPendingClose(null);
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
                const then = pendingClose;
                setPendingClose(null);
                void closeRun(then ?? undefined);
              }}
            >
              {pendingClose?.kind === "params" ? "Close and rerun" : "Close run"}
            </AlertDialogAction>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
