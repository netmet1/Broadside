import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { GuardHit } from "@/lib/tauri/broadcast";

/** The branch target meaning "this host is done". Reserved: no step may use it
 * as an id (the backend rejects that at save time). */
export const STOP = "stop";

export type SkillKind = "sequence" | "ai";

export type Skill = {
  id: number;
  name: string;
  description: string;
  icon: string | null;
  kind: SkillKind;
  /** Kind-specific blob: {@link SequenceConfig} for `sequence`. Opaque to the
   * store; parsed here and in the Rust engine. */
  config_json: string;
  created_at: string;
  updated_at: string;
};

export type SkillInput = {
  name: string;
  description: string;
  icon: string | null;
  kind: SkillKind;
  config_json: string;
};

/** A value the user fills in just before the run. */
export type SkillParam = {
  key: string;
  label: string;
  required: boolean;
  default?: string;
};

/** What to do when a step's pattern doesn't arrive in time. `pause` (the
 * default) hands the host to the operator rather than failing silently. */
export type TimeoutAction = "fail" | "pause";

export type MatchBranch = {
  pattern: string;
  ifMatch: string;
  ifNoMatch: string;
};

export type SeqStep =
  | {
      kind: "run";
      id: string;
      command: string;
      /** Skips the completion marker for a command that never returns to the
       * prompt on its own (`sudo -i` opens a nested shell; a program stops on a
       * question). Advances once output settles; drive the rest with
       * expect/send. */
      interactive?: boolean;
      timeoutSecs?: number;
      onTimeout?: TimeoutAction;
      onSuccess: string;
      onFailure: string;
      /** An output test, taking precedence over the exit code when set. */
      match?: MatchBranch;
    }
  | {
      kind: "expect";
      id: string;
      /** Regex over the ANSI-stripped view. Anchors are LINE anchors: `^Ready$`
       * means a line that says Ready. */
      pattern: string;
      sendOnMatch?: string;
      timeoutSecs?: number;
      onTimeout?: TimeoutAction;
      onMatch: string;
    }
  | { kind: "send"; id: string; input: string; next: string }
  | {
      // Hold on the current screen for a fixed time, sending nothing, while the
      // live pane keeps rendering. For letting a redrawing status screen sit
      // before the skill moves on or finishes.
      kind: "wait";
      id: string;
      seconds: number;
      next: string;
    };

export type SequenceConfig = {
  params: SkillParam[];
  startStepId: string;
  steps: SeqStep[];
};

export function emptySequence(): SequenceConfig {
  return { params: [], startStepId: "", steps: [] };
}

/** Parses a stored config, falling back to an empty sequence rather than
 * throwing: a skill row that predates a field shouldn't break the list. */
export function parseSequence(configJson: string): SequenceConfig {
  try {
    const parsed = JSON.parse(configJson) as Partial<SequenceConfig>;
    return {
      params: parsed.params ?? [],
      startStepId: parsed.startStepId ?? "",
      steps: parsed.steps ?? [],
    };
  } catch {
    return emptySequence();
  }
}

export function listSkills(): Promise<Skill[]> {
  return invoke<Skill[]>("list_skills");
}

export function getSkill(id: number): Promise<Skill> {
  return invoke<Skill>("get_skill", { id });
}

export function createSkill(input: SkillInput): Promise<Skill> {
  return invoke<Skill>("create_skill", { input });
}

export function updateSkill(id: number, input: SkillInput): Promise<Skill> {
  return invoke<Skill>("update_skill", { id, input });
}

export function deleteSkill(id: number): Promise<number> {
  return invoke<number>("delete_skill", { id });
}

/** What the operator should know before dispatching. */
export type SkillPreflight = {
  matchedRules: GuardHit[];
  usesSudo: boolean;
  /** Labels of hosts whose sudo steps will fail for want of a stored password. */
  hostsMissingSudo: string[];
};

export function skillPreflight(args: {
  skillId: number;
  hostIds: number[];
  params: Record<string, string>;
}): Promise<SkillPreflight> {
  return invoke<SkillPreflight>("skill_preflight", args);
}

/** One live terminal a run is driving. */
export type SkillPane = {
  hostId: number;
  label: string;
  color: string;
  sessionId: string;
};

/** Dispatches the skill. Resolves once the runs are launched, not when they
 * finish, handing back the panes to mount. */
export function runSkill(args: {
  runId: string;
  hostIds: number[];
  skillId: number;
  params: Record<string, string>;
  confirmed: boolean;
  cols: number;
  rows: number;
}): Promise<SkillPane[]> {
  return invoke<SkillPane[]>("run_skill", args);
}

/** Emergency stop: kills the sequence on every host at once. Irreversible:
 * it can leave a host mid-`apt`. Per-host {@link skillAbort} is the graceful one. */
export function skillCancel(runId: string): Promise<void> {
  return invoke<void>("skill_cancel", { runId });
}

/** Wait for the paused step's pattern again, with a fresh timeout. Does not
 * re-send a command that is still running. */
export function skillResume(runId: string, hostId: number): Promise<void> {
  return invoke<void>("skill_resume", { runId, hostId });
}

/** Treat the paused step as satisfied and take its success branch. */
export function skillSkipStep(runId: string, hostId: number): Promise<void> {
  return invoke<void>("skill_skip_step", { runId, hostId });
}

/** Stop one host, leaving the others running. */
export function skillAbort(runId: string, hostId: number): Promise<void> {
  return invoke<void>("skill_abort", { runId, hostId });
}

/** Manual takeover: type into the host's live shell. */
export function skillSendInput(
  runId: string,
  hostId: number,
  data: string,
): Promise<void> {
  return invoke<void>("skill_send_input", { runId, hostId, data });
}

export type SkillProgress = {
  runId: string;
  hostId: number;
  label: string;
  sessionId: string;
  stepId: string | null;
  phase: "started" | "step" | "matched" | "sent" | "timeout" | "info" | "failed";
  detail: string;
};

export type SkillPaused = {
  runId: string;
  hostId: number;
  label: string;
  sessionId: string;
  stepId: string;
  reason: string;
};

export type SkillDone = {
  runId: string;
  hostId: number;
  label: string;
  sessionId: string;
  ok: boolean;
  message: string;
};

export function onSkillProgress(
  handler: (p: SkillProgress) => void,
): Promise<UnlistenFn> {
  return listen<SkillProgress>("skill:progress", (e) => handler(e.payload));
}

export function onSkillPaused(
  handler: (p: SkillPaused) => void,
): Promise<UnlistenFn> {
  return listen<SkillPaused>("skill:paused", (e) => handler(e.payload));
}

export function onSkillDone(
  handler: (p: SkillDone) => void,
): Promise<UnlistenFn> {
  return listen<SkillDone>("skill:done", (e) => handler(e.payload));
}
