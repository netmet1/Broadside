import { NEXT, STOP, type SeqStep } from "@/lib/tauri/skills";

/**
 * Turns a sequence skill's steps into the branch graph they actually describe,
 * so it can be drawn and checked.
 *
 * A skill is a graph, not a list: every step names where it goes on each
 * outcome, and `next` means "whatever is below me right now". Reading that off
 * a column of cards is guesswork past about four steps, and two mistakes are
 * invisible in the list entirely: a step nothing points at (it will never run),
 * and a loop with no way out (it burns the engine's execution cap and fails the
 * host late).
 *
 * Pure and React-free on purpose: the analysis is the part worth being sure
 * about, and it can be reasoned about (and later tested) on its own.
 */

/** The synthetic node every `stop` branch terminates at. Not a real step id;
 * `stop` is reserved so no step can collide with it. */
export const STOP_NODE = STOP;

/** One outgoing branch, with the concrete step it resolves to. */
export type FlowEdge = {
  from: string;
  /** A step id, or {@link STOP_NODE}. */
  to: string;
  /** What this branch means: "ok", "fail", "match", "no match", "then", "next". */
  label: string;
  /** This edge closes a loop, i.e. it points back at a step already on the path. */
  isBackEdge: boolean;
};

export type FlowNode = {
  step: SeqStep;
  /** One line describing what the step does, for the box. */
  summary: string;
  /** Distance from the start step, for the layered layout. `null` when the step
   * is unreachable, so it can be parked in its own row. */
  depth: number | null;
};

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Ids no branch from the start step can reach. */
  unreachable: string[];
  /** Loops, each as the id path that closes it, e.g. ["s3", "s4", "s3"]. */
  cycles: string[][];
  /** Whether any branch finishes the host, so the map knows to draw the stop
   * node at all. */
  hasStop: boolean;
};

/**
 * Resolves a branch target the way the backend does before a run: `next` means
 * the step after this one in list order, and a `next` on the last step finishes
 * the host. Everything else passes through, so the map shows what will actually
 * execute rather than the literal config.
 */
export function resolveTarget(
  target: string,
  steps: SeqStep[],
  fromIndex: number,
): string {
  if (target !== NEXT) return target;
  return steps[fromIndex + 1]?.id ?? STOP_NODE;
}

/** Every branch a step declares, paired with what that branch means. Shared
 * with `useSequenceForm` so a new step kind only has to be taught here. */
export function branchTargets(step: SeqStep): { target: string; label: string }[] {
  switch (step.kind) {
    case "run":
      return [
        // A `match` test outranks the exit code, so when one is set the exit
        // branches are unreachable and would be a lie to draw.
        ...(step.match
          ? [
              { target: step.match.ifMatch, label: "match" },
              { target: step.match.ifNoMatch, label: "no match" },
            ]
          : [
              { target: step.onSuccess, label: "ok" },
              { target: step.onFailure, label: "fail" },
            ]),
      ];
    case "expect":
      return [{ target: step.onMatch, label: "then" }];
    case "send":
    case "wait":
      return [{ target: step.next, label: "next" }];
  }
}

/** Just the raw target strings, for callers that only need to know what a step
 * points at (the editor's "nothing follows this" warning). */
export function branchTargetIds(step: SeqStep): string[] {
  return branchTargets(step).map((b) => b.target);
}

function truncate(s: string, max = 46): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The one-liner shown inside a node's box. */
export function stepSummary(step: SeqStep): string {
  switch (step.kind) {
    case "run":
      return truncate(step.command || "(no command)");
    case "expect":
      return truncate(
        step.sendOnMatch
          ? `/${step.pattern}/ then send ${JSON.stringify(step.sendOnMatch)}`
          : `/${step.pattern || "(no pattern)"}/`,
      );
    case "send":
      return truncate(`send ${JSON.stringify(step.input)}`);
    case "wait":
      return `wait ${step.seconds}s`;
  }
}

/** The full, untruncated description, for the hint bar and the detail panel. */
export function stepDetail(step: SeqStep): string {
  switch (step.kind) {
    case "run":
      return `${step.interactive ? "Interactive run" : "Run"}: ${step.command || "(no command)"}`;
    case "expect":
      return `Wait for /${step.pattern}/${
        step.sendOnMatch ? `, then send ${JSON.stringify(step.sendOnMatch)}` : ""
      }`;
    case "send":
      return `Send ${JSON.stringify(step.input)}`;
    case "wait":
      return `Hold for ${step.seconds} seconds`;
  }
}

/**
 * Builds the graph, plus the two things worth warning about.
 *
 * Reachability is a plain BFS from the start step. Cycle detection is an
 * iterative DFS with the usual three-colour marking (unvisited / on the current
 * path / done); an edge back to a step on the current path closes a loop, and
 * the path from that step onward is the loop itself.
 */
export function buildFlowGraph(
  steps: SeqStep[],
  startStepId: string,
): FlowGraph {
  const byId = new Map(steps.map((s) => [s.id, s]));

  // Resolved adjacency, built once and reused by the walks below.
  const out = new Map<string, { to: string; label: string }[]>();
  for (const [i, step] of steps.entries()) {
    out.set(
      step.id,
      branchTargets(step).map((b) => ({
        to: resolveTarget(b.target, steps, i),
        label: b.label,
      })),
    );
  }

  // Reachability from the start step.
  const depth = new Map<string, number>();
  const start = byId.has(startStepId) ? startStepId : steps[0]?.id;
  if (start) {
    depth.set(start, 0);
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const edge of out.get(id) ?? []) {
        if (edge.to === STOP_NODE || depth.has(edge.to) || !byId.has(edge.to)) {
          continue;
        }
        depth.set(edge.to, depth.get(id)! + 1);
        queue.push(edge.to);
      }
    }
  }

  // Cycles, and which edges close them, so the map can draw those differently.
  const backEdges = new Set<string>();
  const cycles: string[][] = [];
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const walk = (id: string) => {
    state.set(id, "open");
    path.push(id);
    for (const edge of out.get(id) ?? []) {
      if (edge.to === STOP_NODE || !byId.has(edge.to)) continue;
      const seen = state.get(edge.to);
      if (seen === "open") {
        backEdges.add(`${id}->${edge.to}`);
        const at = path.indexOf(edge.to);
        cycles.push([...path.slice(at), edge.to]);
      } else if (seen === undefined) {
        walk(edge.to);
      }
    }
    path.pop();
    state.set(id, "done");
  };
  // Walk from the start first so a reported loop reads in run order, then
  // sweep the rest: an unreachable island can still contain a loop, and the
  // operator is about to be told the island is unreachable anyway.
  if (start) walk(start);
  for (const s of steps) if (!state.has(s.id)) walk(s.id);

  const edges: FlowEdge[] = [];
  for (const step of steps) {
    for (const edge of out.get(step.id) ?? []) {
      // A branch pointing at a step that no longer exists can't be drawn. The
      // editor repoints these to stop on delete, so this is belt and braces.
      if (edge.to !== STOP_NODE && !byId.has(edge.to)) continue;
      edges.push({
        from: step.id,
        to: edge.to,
        label: edge.label,
        isBackEdge: backEdges.has(`${step.id}->${edge.to}`),
      });
    }
  }

  const nodes: FlowNode[] = steps.map((step) => ({
    step,
    summary: stepSummary(step),
    depth: depth.get(step.id) ?? null,
  }));

  return {
    nodes,
    edges,
    unreachable: steps.filter((s) => !depth.has(s.id)).map((s) => s.id),
    cycles,
    hasStop: edges.some((e) => e.to === STOP_NODE),
  };
}

/** Reader-friendly warnings about the graph, for the overview. Never blocking:
 * a loop is a legitimate pattern (poll until ready, with an exit branch) and
 * the engine caps runaway execution anyway. */
export function flowWarnings(graph: FlowGraph): string[] {
  const out: string[] = [];
  for (const id of graph.unreachable) {
    out.push(
      `Step ${id} is never reached. Nothing branches to it, so it will not run.`,
    );
  }
  // One warning per distinct loop, named by the steps in it.
  const seen = new Set<string>();
  for (const cycle of graph.cycles) {
    const members = [...new Set(cycle)].sort();
    const key = members.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      members.length === 1
        ? `Step ${members[0]} branches back to itself. Give it a way out, or a run that reaches it stops at the 100 step cap and fails the host.`
        : `Steps ${members.join(" and ")} loop back on each other (${cycle.join(" to ")}). Unless a branch leaves the loop, a run that enters it stops at the 100 step cap and fails the host.`,
    );
  }
  return out;
}
