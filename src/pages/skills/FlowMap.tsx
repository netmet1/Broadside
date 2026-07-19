import { useMemo } from "react";

import { useHint } from "@/lib/status";
import type { SeqStep } from "@/lib/tauri/skills";
import {
  buildFlowGraph,
  stepDetail,
  STOP_NODE,
  type FlowGraph,
} from "@/pages/skills/flowGraph";

/**
 * Draws a sequence skill's branch graph.
 *
 * Hand-rolled SVG rather than a graph library: the layout is a plain layered
 * one (a row per hop from the start step), and pulling in a diagram dependency
 * to draw a dozen boxes would be a lot of weight for a read-only view.
 *
 * Read-only by design. Editing lives in the builder, which this deliberately
 * does not touch: clicking a node selects it here, it does not change anything.
 */

const NODE_W = 200;
const NODE_H = 54;
const GAP_X = 32;
const GAP_Y = 74;
const PAD = 16;
const STOP_W = 96;
const STOP_H = 30;

/** Per-kind tint, matching how the step cards read in the builder. */
const KIND_FILL: Record<SeqStep["kind"], string> = {
  run: "rgb(59 130 246 / 0.12)",
  expect: "rgb(168 85 247 / 0.12)",
  send: "rgb(16 185 129 / 0.12)",
  wait: "rgb(148 163 184 / 0.14)",
};
const KIND_STROKE: Record<SeqStep["kind"], string> = {
  run: "rgb(59 130 246 / 0.55)",
  expect: "rgb(168 85 247 / 0.55)",
  send: "rgb(16 185 129 / 0.55)",
  wait: "rgb(148 163 184 / 0.6)",
};
const KIND_LABEL: Record<SeqStep["kind"], string> = {
  run: "run",
  expect: "wait for",
  send: "send",
  wait: "hold",
};

type Placed = { id: string; x: number; y: number; w: number; h: number };

/** Lays the nodes out in rows: one row per hop from the start, then a final row
 * for anything unreachable, then the stop node under everything. */
function layout(graph: FlowGraph): {
  placed: Map<string, Placed>;
  width: number;
  height: number;
  unreachableRowY: number | null;
} {
  const rows = new Map<number, string[]>();
  for (const node of graph.nodes) {
    if (node.depth === null) continue;
    const row = rows.get(node.depth) ?? [];
    row.push(node.step.id);
    rows.set(node.depth, row);
  }
  const orphans = graph.unreachable;
  const depths = [...rows.keys()].sort((a, b) => a - b);
  const widest = Math.max(
    1,
    ...depths.map((d) => rows.get(d)!.length),
    orphans.length,
  );
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X;

  const placed = new Map<string, Placed>();
  const place = (ids: string[], y: number) => {
    const rowWidth = ids.length * NODE_W + (ids.length - 1) * GAP_X;
    const left = (width - rowWidth) / 2;
    ids.forEach((id, i) => {
      placed.set(id, {
        id,
        x: left + i * (NODE_W + GAP_X),
        y,
        w: NODE_W,
        h: NODE_H,
      });
    });
  };

  let y = PAD;
  for (const d of depths) {
    place(rows.get(d)!, y);
    y += NODE_H + GAP_Y;
  }
  let unreachableRowY: number | null = null;
  if (orphans.length > 0) {
    y += 14; // a little air, so the "not reached" band reads as separate
    unreachableRowY = y;
    place(orphans, y);
    y += NODE_H + GAP_Y;
  }
  if (graph.hasStop) {
    placed.set(STOP_NODE, {
      id: STOP_NODE,
      x: (width - STOP_W) / 2,
      y,
      w: STOP_W,
      h: STOP_H,
    });
    y += STOP_H;
  } else {
    y -= GAP_Y;
  }

  return { placed, width, height: y + PAD, unreachableRowY };
}

export function FlowMap({
  steps,
  startStepId,
  selectedId,
  onSelect,
}: {
  steps: SeqStep[];
  startStepId: string;
  /** The step whose detail is showing, drawn with a ring. */
  selectedId: string | null;
  onSelect: (stepId: string | null) => void;
}) {
  const hint = useHint();
  const graph = useMemo(
    () => buildFlowGraph(steps, startStepId),
    [steps, startStepId],
  );
  const { placed, width, height, unreachableRowY } = useMemo(
    () => layout(graph),
    [graph],
  );

  if (steps.length === 0) {
    return (
      <p className="rounded-md border border-border/60 p-6 text-center text-xs text-muted-foreground">
        This skill has no steps yet.
      </p>
    );
  }

  const unreachable = new Set(graph.unreachable);

  return (
    <div className="overflow-auto rounded-md border border-border/60 bg-muted/10 p-2">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="max-w-none"
        role="img"
        aria-label="Flow of this skill's steps"
      >
        <defs>
          <marker
            id="flow-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
          </marker>
        </defs>

        {unreachableRowY !== null && (
          <text
            x={PAD}
            y={unreachableRowY - 8}
            className="fill-amber-600 dark:fill-amber-400"
            fontSize="10"
          >
            not reached
          </text>
        )}

        {/* Edges first, so the boxes sit on top of the lines. */}
        <g className="text-muted-foreground/70">
          {graph.edges.map((edge, i) => {
            const from = placed.get(edge.from);
            const to = placed.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + from.w / 2;
            const y1 = from.y + from.h;
            const x2 = to.x + to.w / 2;
            const y2 = to.y;
            // A back edge runs upward, so route it out to the side rather than
            // straight through the boxes between the two ends.
            const path = edge.isBackEdge
              ? `M ${x1} ${from.y} C ${x1 - NODE_W * 0.9} ${from.y - 30}, ${x2 - NODE_W * 0.9} ${y2 + to.h + 30}, ${x2} ${y2 + to.h}`
              : `M ${x1} ${y1} C ${x1} ${y1 + GAP_Y / 2}, ${x2} ${y2 - GAP_Y / 2}, ${x2} ${y2}`;
            const midX = edge.isBackEdge
              ? Math.min(x1, x2) - NODE_W * 0.55
              : (x1 + x2) / 2;
            const midY = edge.isBackEdge
              ? (from.y + y2 + to.h) / 2
              : (y1 + y2) / 2;
            return (
              <g key={`${edge.from}-${edge.to}-${edge.label}-${i}`}>
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
                  strokeDasharray={edge.isBackEdge ? "4 3" : undefined}
                  markerEnd="url(#flow-arrow)"
                  className={
                    edge.isBackEdge ? "text-amber-500" : "text-muted-foreground/70"
                  }
                />
                <rect
                  x={midX - edge.label.length * 3 - 4}
                  y={midY - 7}
                  width={edge.label.length * 6 + 8}
                  height={14}
                  rx={7}
                  className="fill-background"
                />
                <text
                  x={midX}
                  y={midY + 3.5}
                  textAnchor="middle"
                  fontSize="9"
                  className={
                    edge.isBackEdge
                      ? "fill-amber-600 dark:fill-amber-400"
                      : "fill-muted-foreground"
                  }
                >
                  {edge.label}
                </text>
              </g>
            );
          })}
        </g>

        {/* Step boxes. */}
        {graph.nodes.map((node) => {
          const box = placed.get(node.step.id);
          if (!box) return null;
          const isStart = node.step.id === startStepId;
          const isOrphan = unreachable.has(node.step.id);
          const isSelected = node.step.id === selectedId;
          return (
            <g
              key={node.step.id}
              className="cursor-pointer"
              onClick={() => onSelect(isSelected ? null : node.step.id)}
              {...hint(`${node.step.id}: ${stepDetail(node.step)}`)}
            >
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={8}
                fill={KIND_FILL[node.step.kind]}
                stroke={
                  isOrphan ? "rgb(245 158 11 / 0.8)" : KIND_STROKE[node.step.kind]
                }
                strokeWidth={isSelected ? 2 : 1}
                strokeDasharray={isOrphan ? "5 3" : undefined}
                opacity={isOrphan ? 0.75 : 1}
              />
              {isSelected && (
                <rect
                  x={box.x - 3}
                  y={box.y - 3}
                  width={box.w + 6}
                  height={box.h + 6}
                  rx={11}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1}
                  className="text-primary"
                />
              )}
              <text
                x={box.x + 10}
                y={box.y + 17}
                fontSize="11"
                className="fill-foreground font-mono"
              >
                {node.step.id}
              </text>
              <text
                x={box.x + 10 + node.step.id.length * 7 + 6}
                y={box.y + 17}
                fontSize="9"
                className="fill-muted-foreground"
              >
                {KIND_LABEL[node.step.kind]}
                {isStart ? " · start" : ""}
              </text>
              <text
                x={box.x + 10}
                y={box.y + 36}
                fontSize="10"
                className="fill-muted-foreground"
              >
                {node.summary}
              </text>
            </g>
          );
        })}

        {/* The one terminal node every `stop` branch lands on. */}
        {graph.hasStop &&
          (() => {
            const box = placed.get(STOP_NODE)!;
            return (
              <g>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={15}
                  className="fill-muted stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={box.x + box.w / 2}
                  y={box.y + 19}
                  textAnchor="middle"
                  fontSize="10"
                  className="fill-muted-foreground"
                >
                  host finished
                </text>
              </g>
            );
          })()}
      </svg>
    </div>
  );
}
