import { invoke } from "@tauri-apps/api/core";

import type { SkillLogDetail } from "./settings";

/** One step of a run, as the engine saw it. */
export type SkillLogStep = {
  step_id: string;
  /** `run` | `expect` | `send` | `wait` | `log`. */
  kind: string;
  /** Position in the order the steps actually ran, which is not the order they
   * are listed in: a skill branches. */
  index: number;
  command?: string;
  /** The line Broadside typed, present only where it differs from the command.
   * Debug only. */
  sent?: string;
  /** What the host said back, already trimmed by the backend. Debug only. */
  output?: string;
  exit_code?: number;
  /** `pass` | `fail` | `timeout` | `skipped` | `done`. */
  condition: string;
  next?: string;
  took_ms: number;
  /** The lines the run panel showed for this step. Panel level only. */
  panel?: string[];
};

/** A whole run against one host. */
export type SkillLogRun = {
  ts: string;
  run_id: string;
  host_id: number;
  host_label: string;
  skill: string;
  detail: SkillLogDetail;
  commands: number;
  completed: number;
  failed: number;
  duration_ms: number;
  /** `SUCCESS` | `FAILED`. */
  result: string;
  message: string;
  steps?: SkillLogStep[];
};

export async function skillLogTail(maxLines: number): Promise<SkillLogRun[]> {
  const lines = await invoke<string[]>("skill_log_tail", { maxLines });
  const runs: SkillLogRun[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      runs.push(JSON.parse(line) as SkillLogRun);
    } catch {
      // A corrupt line must not hide the rest of the log. It has no shape to
      // render, so it is shown as a run that says what it is.
      runs.push({
        ts: "",
        run_id: "",
        host_id: -1,
        host_label: "?",
        skill: "unreadable entry",
        detail: "summary",
        commands: 0,
        completed: 0,
        failed: 0,
        duration_ms: 0,
        result: "FAILED",
        message: line,
      });
    }
  }
  return runs;
}

export function clearSkillLog(): Promise<number> {
  return invoke<number>("clear_skill_log");
}

/** Copies the skill log to `dest`. Returns bytes written. Always the raw JSONL:
 * an export is for something else to read, and the something else wants the
 * structure. */
export function exportSkillLog(dest: string): Promise<number> {
  return invoke<number>("export_skill_log", { dest });
}

/** Seconds to one decimal, the way the run panel shows a duration. */
function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Indents a block of text so it reads as belonging to the line above it. */
function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => by + l)
    .join("\n");
}

/**
 * One run as prose.
 *
 * The four detail levels are four renderings of the same record rather than
 * four records, which is why the file can be read at a level it was not written
 * at: a run written down as Itemized still shows as a summary if the operator
 * switches, it just has nothing further to say. The one direction that does not
 * work is asking for more than was kept, and each level says what it has.
 */
export function renderRun(run: SkillLogRun): string {
  const head = [
    `Skill: ${run.skill}`,
    `Host: ${run.host_label}`,
    `Commands: ${run.commands}`,
    `Completed: ${run.completed}`,
    `Failed: ${run.failed}`,
    `Duration: ${secs(run.duration_ms)}`,
    `Result: ${run.result}`,
  ];
  if (run.message) head.push(`Message: ${run.message}`);
  const steps = run.steps ?? [];
  if (steps.length === 0) return head.join("\n");

  const total = steps.length;
  const blocks = steps.map((s) => {
    // Panel: the account the operator already knows how to read, kept as they
    // read it.
    if (run.detail === "panel") {
      const lines = s.panel ?? [];
      return lines.length > 0 ? lines.join("\n") : `${s.step_id}: (nothing shown)`;
    }
    const label = s.command ?? s.step_id;
    const exit = s.exit_code === undefined ? "" : ` exit ${s.exit_code}`;
    const line = `${String(s.index).padStart(2)}/${total} ${s.kind}: ${label}${exit} [${s.condition}] ${secs(s.took_ms)}`;
    if (run.detail !== "debug") return line;

    const detail: string[] = [line];
    // Only the lines where Broadside composed something have a `sent`, so an
    // entry that shows one is an entry where the difference is the point.
    if (s.sent) detail.push(indent(`Broadside typed:\n${indent(s.sent)}`));
    if (s.output) detail.push(indent(`Output:\n${indent(s.output)}`));
    if (s.next) detail.push(indent(`Went to: ${s.next}`));
    if (s.panel && s.panel.length > 0) {
      detail.push(indent(`Panel:\n${indent(s.panel.join("\n"))}`));
    }
    return detail.join("\n");
  });
  return [...head, "", ...blocks].join("\n");
}
