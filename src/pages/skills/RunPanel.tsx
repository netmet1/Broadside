import { useState } from "react";
import {
  CheckIcon,
  EyeIcon,
  KeyboardIcon,
  LockIcon,
  PlayIcon,
  SkipForwardIcon,
  SquareIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/tauri/hosts";
import {
  skillAbort,
  skillResume,
  skillSendInput,
  skillSkipStep,
} from "@/lib/tauri/skills";
import { useHint } from "@/lib/status";
import { SkillTerminalPane } from "@/pages/skills/SkillTerminalPane";
import type { HostRunState } from "@/pages/skills/useSkillRun";

/** Live per-host terminals while a skill drives them, with the controls to take
 * one over. */
export function RunPanel({
  runId,
  hosts,
  skillName,
  active,
  visible,
  setTakenOver,
  finishHost,
  onDone,
}: {
  runId: string;
  hosts: HostRunState[];
  skillName: string;
  active: boolean;
  /** Whether this panel is the thing on screen (it is kept mounted while
   * hidden, so its terminals need to refit when it returns). */
  visible: boolean;
  setTakenOver: (hostId: number, takenOver: boolean) => void;
  /** Settle a host the backend has already forgotten about. */
  finishHost: (hostId: number, message: string) => void;
  onDone: () => void;
}) {
  const hint = useHint();
  // Which pane fills the panel, or null for the grid. A run over eight hosts is
  // unreadable at grid size the moment one needs attention.
  const [focused, setFocused] = useState<number | null>(null);
  const shown = focused == null ? hosts : hosts.filter((h) => h.pane.hostId === focused);
  const paused = hosts.filter((h) => h.status === "paused");
  /** Exactly one pane on screen, so it should fill the panel. */
  const single = focused != null || hosts.length === 1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The locked "this is attended" banner: expect automation is brittle by
          nature, and the operator should be watching, not walking away. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-amber-300/70 bg-amber-50 px-4 py-1.5 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300/90">
        <EyeIcon className="h-3.5 w-3.5 shrink-0" />
        <span>
          <span className="font-semibold">Not set-and-forget. Watch it.</span>{" "}
          {skillName} is driving a live shell on{" "}
          {hosts.length === 1 ? "1 host" : `${hosts.length} hosts`}. A step whose
          prompt never arrives pauses and waits for you.
        </span>
        {paused.length > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 font-semibold">
            {paused.length} waiting for you
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border/30 px-3 py-1.5">
        {focused != null && (
          <Button variant="outline" size="sm" onClick={() => setFocused(null)}>
            Back to all hosts
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {hosts.filter((h) => h.status === "done").length} done ·{" "}
          {hosts.filter((h) => h.status === "failed").length} failed ·{" "}
          {hosts.filter((h) => h.status === "running").length} running
        </span>
        {!active && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={onDone}
            {...hint("Clear this run and pick another skill")}
          >
            Close run
          </Button>
        )}
      </div>

      {/* One pane fills the panel; several tile. `flex-col` (not bare `flex`)
          with a `flex-1` child is what makes the single pane take the full width
          and height: a flex row child with no grow sizes to its own content,
          which had the terminal shrinking to the width of its header text. */}
      <div
        className={`min-h-0 flex-1 gap-2 overflow-auto p-2 ${
          single ? "flex flex-col" : "grid grid-cols-1 lg:grid-cols-2"
        }`}
      >
        {shown.map((h) => (
          <HostPane
            key={h.pane.hostId}
            runId={runId}
            host={h}
            fill={single}
            visible={visible}
            onFocus={() => setFocused(h.pane.hostId)}
            onFinished={(m) => finishHost(h.pane.hostId, m)}
            setTakenOver={setTakenOver}
          />
        ))}
      </div>
    </div>
  );
}

function HostPane({
  runId,
  host,
  fill,
  visible,
  onFocus,
  onFinished,
  setTakenOver,
}: {
  runId: string;
  host: HostRunState;
  /** This pane is the only one on screen, so it fills the panel and its own
   * focus control is spent. */
  fill: boolean;
  /** Whether the run panel is on screen (for the terminal's refit). */
  visible: boolean;
  onFocus: () => void;
  /** Settle this pane when the backend says its run is already over. */
  onFinished: (message: string) => void;
  setTakenOver: (hostId: number, takenOver: boolean) => void;
}) {
  const hint = useHint();
  const { pane, status } = host;
  const finished = status === "done" || status === "failed";

  const control = async (fn: () => Promise<void>, what: string) => {
    try {
      await fn();
    } catch (e) {
      const message = errorMessage(e);
      // The backend has no record of this host, so its run is over however it
      // ended. Settle the pane rather than leaving the operator pressing
      // buttons that all answer the same way.
      if (/already ended|no active skill run/i.test(message)) {
        onFinished("this host's run had already ended");
        toast.info("That host's run had already ended.");
        return;
      }
      toast.error(`${what}: ${message}`);
    }
  };

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden rounded-md border ${
        status === "paused"
          ? "border-amber-400/70"
          : status === "failed"
            ? "border-red-400/60"
            : "border-border/50"
      } ${fill ? "w-full flex-1" : "min-h-[18rem]"}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-muted/30 px-2 py-1.5">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: pane.color }}
        />
        {/* Zooming to a pane that already fills the panel would only strand a
            "Back to all hosts" button with nothing to go back to. */}
        <button
          type="button"
          onClick={onFocus}
          disabled={fill}
          className="min-w-0 truncate text-sm font-medium hover:underline disabled:no-underline"
          title={fill ? pane.label : `Focus ${pane.label}`}
        >
          {pane.label}
        </button>
        <StatusChip host={host} />
        <span
          className="ml-auto min-w-0 shrink truncate font-mono text-[11px] text-muted-foreground"
          title={host.step}
        >
          {finished ? host.message : host.step}
        </span>
      </div>

      {/* Paused: the engine has stopped sending and handed the shell over. */}
      {status === "paused" && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-400/40 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300/90">
          <TriangleAlertIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{host.pausedReason}</span>
          <Button
            size="sm"
            variant={host.takenOver ? "default" : "outline"}
            className="h-6 px-2 text-xs"
            onClick={() => setTakenOver(pane.hostId, !host.takenOver)}
            {...hint(
              "Type into this host's shell yourself. Automation stays stopped until you resume.",
            )}
          >
            <KeyboardIcon className="mr-1 h-3 w-3" />
            {host.takenOver ? "You have the keyboard" : "Take over"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() =>
              control(() => skillResume(runId, pane.hostId), "Resume failed")
            }
            {...hint(
              "Wait for this step's prompt again, with a fresh timeout. Does not re-run the command.",
            )}
          >
            <PlayIcon className="mr-1 h-3 w-3" />
            Resume
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() =>
              control(() => skillSkipStep(runId, pane.hostId), "Skip failed")
            }
            {...hint("Treat this step as done and move to its success branch")}
          >
            <SkipForwardIcon className="mr-1 h-3 w-3" />
            Skip step
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() =>
              control(() => skillAbort(runId, pane.hostId), "Stop failed")
            }
            {...hint("Stop this host. The others keep running.")}
          >
            <SquareIcon className="mr-1 h-3 w-3" />
            Stop host
          </Button>
        </div>
      )}

      {/* Running: say plainly that the keyboard isn't yours yet. The pane looks
          exactly like a terminal you could type into, and typing into it does
          nothing, which reads as the app being broken rather than as the skill
          holding the keyboard. */}
      {status === "running" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/30 px-2 py-1">
          <LockIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            The skill is driving this shell. Typing here does nothing until it
            pauses for you, or you stop it.
          </span>
          {/* A wait step is just a timer, so end it early once you have seen
              what you were waiting for. This moves to the step's Then branch,
              exactly as the timer running out would, so a Wait -> Send key ->
              stop skill sends the key and finishes. */}
          {host.stepKind === "wait" && (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-5 shrink-0 px-1.5 text-[11px]"
              onClick={() =>
                control(() => skillSkipStep(runId, pane.hostId), "Continue failed")
              }
              {...hint(
                "End the wait now and go to its Then branch, the same as the timer finishing.",
              )}
            >
              <SkipForwardIcon className="mr-1 h-3 w-3" />
              Continue now
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={`h-5 shrink-0 px-1.5 text-[11px] text-muted-foreground ${
              host.stepKind === "wait" ? "" : "ml-auto"
            }`}
            onClick={() =>
              control(() => skillAbort(runId, pane.hostId), "Stop failed")
            }
            {...hint("Stop this host after its current step. The others keep running.")}
          >
            Stop host
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 bg-[var(--terminal-bg)]">
        <SkillTerminalPane
          sessionId={pane.sessionId}
          interactive={host.takenOver && status === "paused"}
          visible={visible}
          onInput={(data) => {
            skillSendInput(runId, pane.hostId, data).catch(() => {
              // The run ended under us; the status chip already says so.
            });
          }}
        />
      </div>
    </div>
  );
}

function StatusChip({ host }: { host: HostRunState }) {
  const base = "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium";
  switch (host.status) {
    case "paused":
      return (
        <span className={`${base} bg-amber-500/20 text-amber-700 dark:text-amber-300`}>
          <TriangleAlertIcon className="h-2.5 w-2.5" />
          Waiting for you
        </span>
      );
    case "done":
      return (
        <span className={`${base} bg-emerald-500/15 text-emerald-600 dark:text-emerald-400`}>
          <CheckIcon className="h-2.5 w-2.5" />
          Done
        </span>
      );
    case "failed":
      return (
        <span className={`${base} bg-red-500/15 text-red-600 dark:text-red-400`}>
          <XIcon className="h-2.5 w-2.5" />
          Failed
        </span>
      );
    default:
      return (
        <span className={`${base} bg-muted text-muted-foreground`}>Running</span>
      );
  }
}
