import {
  type ExecResult,
  type HostExecReport,
} from "@/lib/tauri/broadcast";
import type { OtlogLine } from "@/lib/tauri/logs";
import { type LineMatch, type Matcher, matchLine } from "@/lib/search";

export const DEFAULT_TIMEOUT_SECS = 30;
/** How many past runs to reload on mount (matches the backend cap). */
export const HISTORY_RUNS = 200;
/** Persisted collapse state for the host selection rail (mirrors MultiTerminal). */
export const RAIL_COLLAPSED_KEY = "broadcast-rail-collapsed";
/** Persisted "show per-host output headers" toggle (mirrors MultiTerminal O4). */
export const HEADERS_KEY = "broadcast-headers";

/** Initials of each whitespace-separated word, for the collapsed rail. */
export function wordInitials(label: string): string {
  const i = label
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return i || label.slice(0, 2).toUpperCase();
}

export type Block = HostExecReport & { collapsed: boolean; receivedAt: string };

/** One broadcast run: a command sent to N hosts, plus the per-host result
 * blocks (completion order) and the set still pending. Runs append over time
 * and persist across restarts (D-059). */
export type RunGroup = {
  runId: string;
  command: string;
  ts: string;
  blocks: Block[];
  pending: Set<number>;
};

/** Stable per-block key — a host can appear in many runs, so host_id alone is
 * not unique across the appended history. */
export const blockKeyOf = (runId: string, hostId: number) =>
  `${runId}:${hostId}`;

/** One navigable find hit (a single match occurrence). */
export type FindHit = {
  key: string;
  stream: "stdout" | "stderr";
  line: number;
  start: number;
  end: number;
};

export type FindData = {
  byRef: Map<string, Map<number, LineMatch[]>>;
  activeHit: FindHit | null;
};

export function statusSummary(result: ExecResult): {
  text: string;
  tone: "ok" | "warn" | "error";
} {
  switch (result.status) {
    case "completed": {
      if (result.timed_out) {
        return {
          text: `[TIMEOUT] ${(result.duration_ms / 1000).toFixed(1)}s`,
          tone: "error",
        };
      }
      const exit = result.exit_code ?? "?";
      return {
        text: `exit ${exit} · ${(result.duration_ms / 1000).toFixed(1)}s`,
        tone: result.exit_code === 0 ? "ok" : "warn",
      };
    }
    case "unknown_key":
      return { text: "unknown host key", tone: "warn" };
    case "key_mismatch":
      return { text: "HOST KEY CHANGED", tone: "error" };
    case "auth_failed":
      return { text: "auth failed", tone: "error" };
    case "unreachable":
      return { text: "unreachable", tone: "error" };
    case "no_credentials":
      return { text: "no credentials", tone: "warn" };
  }
}

/** Current output as .otlog lines (D-010): per output line, plus a status
 * line per host so failures are part of the record. */
export function otlogLinesFromRuns(runs: RunGroup[]): OtlogLine[] {
  const out: OtlogLine[] = [];
  for (const run of runs) {
    for (const block of run.blocks) {
      out.push({
        ts: block.receivedAt,
        host: block.label,
        stream: "status",
        data: statusSummary(block.result).text,
      });
      if (block.result.status !== "completed") continue;
      for (const stream of ["stdout", "stderr"] as const) {
        const text = block.result[stream];
        if (!text) continue;
        for (const line of text.split("\n")) {
          out.push({ ts: block.receivedAt, host: block.label, stream, data: line });
        }
      }
    }
  }
  return out;
}

export function filteredLines(
  result: Extract<ExecResult, { status: "completed" }>,
  matcher: Matcher,
): { stream: "stdout" | "stderr"; text: string; matches: LineMatch[] }[] {
  const out: {
    stream: "stdout" | "stderr";
    text: string;
    matches: LineMatch[];
  }[] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    const text = result[stream];
    if (!text) continue;
    for (const line of text.split("\n")) {
      const matches = matchLine(matcher, line);
      if (matches.length > 0) out.push({ stream, text: line, matches });
    }
  }
  return out;
}
