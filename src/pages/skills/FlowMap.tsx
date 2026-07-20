import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";

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

/** Zoom stops. A long skill is unreadable at full size in a fixed box and a
 * short one wastes it, so the operator picks; there is no clever auto-fit. */
const ZOOM_STOPS = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2];
const DEFAULT_ZOOM_INDEX = 3;

/** Never shrink the map below this, however little room is left: a sliver of a
 * diagram is worse than a scrollbar. */
const MIN_BOX_H = 200;
/** Breathing room under the map so it doesn't sit flush on the window edge. A
 * long skill that runs right up to the sill reads as if it is overflowing even
 * when it is not, so leave a clear gap below it. */
const BOTTOM_GAP = 44;

/** Inner padding inside a node box, and rough per-character advances for the
 * three fonts we draw with, so a long id or summary can be trimmed to the box
 * width rather than bleeding out the side. SVG has no text-overflow; a fitted
 * string with an ellipsis is the closest we get, and a clip on the box catches
 * anything the estimate underruns. */
const TEXT_PAD_L = 10;
const TEXT_PAD_R = 10;
const ID_CHAR_W = 6.6; // mono, 11px
const LABEL_CHAR_W = 5; // 9px
const SUMMARY_CHAR_W = 5.4; // 10px, proportional; kept generous so wide glyphs fit

/** Trims a string to a pixel width, adding an ellipsis when it doesn't fit. */
function fitText(text: string, maxWidth: number, charW: number): string {
  if (maxWidth <= 0) return "";
  const max = Math.floor(maxWidth / charW);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

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
  reserveBelow,
}: {
  steps: SeqStep[];
  startStepId: string;
  /** The step whose detail is showing, drawn with a ring. */
  selectedId: string | null;
  onSelect: (stepId: string | null) => void;
  /** Pixels the caller needs under the map, which is the step detail panel when
   * one is open. The map gives up exactly that much rather than a fixed guess,
   * so clicking a step never pushes its own settings off the bottom. */
  reserveBelow: number;
}) {
  const hint = useHint();
  const boxRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<number | null>(null);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const zoom = ZOOM_STOPS[zoomIndex]!;
  const graph = useMemo(
    () => buildFlowGraph(steps, startStepId),
    [steps, startStepId],
  );
  const { placed, width, height, unreachableRowY } = useMemo(
    () => layout(graph),
    [graph],
  );

  // How much window is actually left below the top of the map. Measured rather
  // than assumed: a fixed height is either wasteful on a tall screen or leaves
  // the diagram in a letterbox on a short one, and neither guess survives the
  // detail panel opening underneath it.
  //
  // Only the top edge is measured, and nothing above the map moves when the map
  // resizes, so this cannot chase its own tail. Scrolling deliberately does not
  // re-measure: the box would grow and shrink under the pointer as you scrolled.
  useLayoutEffect(() => {
    const measure = () => {
      const box = boxRef.current;
      if (!box) return;
      const top = box.getBoundingClientRect().top;
      setAvail(
        Math.max(MIN_BOX_H, window.innerHeight - top - reserveBelow - BOTTOM_GAP),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [reserveBelow]);

  if (steps.length === 0) {
    return (
      <p className="rounded-md border border-border/60 p-6 text-center text-xs text-muted-foreground">
        This skill has no steps yet.
      </p>
    );
  }

  const unreachable = new Set(graph.unreachable);

  return (
    <div className="relative">
      {/* Pinned over the box rather than inside the scroll area, so the zoom
          stays reachable however far into a long flow you have scrolled. */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-md border border-border/60 bg-background/95 p-0.5 shadow-sm">
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
          aria-label="Zoom out"
          {...hint("Zoom out, to fit more of a long flow on screen")}
        >
          <MinusIcon className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="min-w-[3rem] rounded px-1 py-0.5 text-[10px] tabular-nums text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          onClick={() => setZoomIndex(DEFAULT_ZOOM_INDEX)}
          {...hint("Back to 100%")}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          disabled={zoomIndex === ZOOM_STOPS.length - 1}
          onClick={() =>
            setZoomIndex((i) => Math.min(ZOOM_STOPS.length - 1, i + 1))
          }
          aria-label="Zoom in"
          {...hint("Zoom in")}
        >
          <PlusIcon className="h-3 w-3" />
        </button>
      </div>

      {/* A fixed box that scrolls, not a box that grows with the flow: a
          twenty step skill would otherwise push the step detail below it so far
          down the page that clicking a node scrolled the thing you clicked out
          of view. */}
      <div
        ref={boxRef}
        className="overflow-auto rounded-md border border-border/60 bg-muted/10 p-2 transition-[height]"
        style={{
          // Never taller than the diagram needs: a three step skill gets a
          // small box, not an acre of empty grid.
          height: Math.min(avail ?? MIN_BOX_H * 2, height * zoom + 20),
        }}
      >
        <svg
          width={width * zoom}
          height={height * zoom}
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
          {graph.nodes.map((node, ni) => {
            const box = placed.get(node.step.id);
            if (!box) return null;
            const isStart = node.step.id === startStepId;
            const isOrphan = unreachable.has(node.step.id);
            const isSelected = node.step.id === selectedId;
            const clipId = `fm-clip-${ni}`;

            // The id shares its line with the kind label, so reserve the label's
            // width first and fit the id into whatever is left. The summary gets
            // the full inner width. Everything is clipped to the box as a final
            // guard, so no estimate can bleed past the edge.
            const labelText = `${KIND_LABEL[node.step.kind]}${isStart ? " · start" : ""}`;
            const labelW = labelText.length * LABEL_CHAR_W;
            const idText = fitText(
              node.step.id,
              box.w - TEXT_PAD_L - TEXT_PAD_R - 6 - labelW,
              ID_CHAR_W,
            );
            const summaryText = fitText(
              node.summary,
              box.w - TEXT_PAD_L - TEXT_PAD_R,
              SUMMARY_CHAR_W,
            );
            return (
              <g
                key={node.step.id}
                className="cursor-pointer"
                onClick={() => onSelect(isSelected ? null : node.step.id)}
                {...hint(`${node.step.id}: ${stepDetail(node.step)}`)}
              >
                <clipPath id={clipId}>
                  <rect
                    x={box.x}
                    y={box.y}
                    width={box.w}
                    height={box.h}
                    rx={8}
                  />
                </clipPath>
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
                <g clipPath={`url(#${clipId})`}>
                  <text
                    x={box.x + TEXT_PAD_L}
                    y={box.y + 17}
                    fontSize="11"
                    className="fill-foreground font-mono"
                  >
                    {idText}
                  </text>
                  <text
                    x={box.x + TEXT_PAD_L + idText.length * ID_CHAR_W + 6}
                    y={box.y + 17}
                    fontSize="9"
                    className="fill-muted-foreground"
                  >
                    {labelText}
                  </text>
                  <text
                    x={box.x + TEXT_PAD_L}
                    y={box.y + 36}
                    fontSize="10"
                    className="fill-muted-foreground"
                  >
                    {summaryText}
                  </text>
                </g>
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
    </div>
  );
}
