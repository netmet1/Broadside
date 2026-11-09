import { Fragment } from "react";

import { flowPlace, type Flow } from "@/lib/gridShape";
import type { SplitLine } from "@/pages/terminals/useGridSplitters";

/**
 * The handles for the lines between grid tiles while the tiles are unlocked:
 * one per line, centred on the gap, so the line you can see is the thing you
 * grab. The bottom of a tile is the line under its row (and the bottom of the
 * last row is a line too, unless the rows fit the window); the right of a tile
 * is the line beside it in its own row (see useGridSplitters). The right edge
 * of a tile with blank space beside it, or alone in its row, has a handle too,
 * which sets its width.
 *
 * Each handle is a grid item of its own, placed in the area of the tile above
 * or to the left of its line and pushed out over the gap with a negative
 * margin, reaching a few pixels into the tiles either side. Drawn by the grid
 * rather than by the tiles because a tile clips what overflows it: inside the
 * tiles, every line had a strip on each side of the gap, two things to grab
 * and two to light for the one line. Only the tile above and the tile to the
 * left hold handles, so no line gets two.
 *
 * Above the terminals (z-20), because xterm's own scrollbar sits at z 11 and
 * would otherwise take the right edge.
 */
export function SplitHandles({
  flow,
  fitRows,
  onBegin,
}: {
  flow: Flow;
  /** Rows always fill the pane (Settings -> Grid), so the grid's bottom edge
   * is not a line. */
  fitRows: boolean;
  onBegin: (e: React.MouseEvent, line: SplitLine) => void;
}) {
  const rowsHint = fitRows
    ? "Drag to move the line between these rows"
    : "Drag to set the height of the row above this line. The rows below move, and the grid scrolls when they do not fit";
  const lastHint = fitRows
    ? rowsHint
    : "Drag to set this row's height. The rows below move, and the grid scrolls when they do not fit";
  const pairHint =
    "Drag to move the line between these tiles. Past the minimum width (Settings > Grid), the tile on the right moves down a row";
  const edgeHint = "Drag to set this tile's width";
  return (
    <>
      {flow.tiles.map((tile, slot) => {
        const lastRow = tile.row + tile.rowSpan - 1;
        const right = flow.rightLine[slot] ?? null;
        const place = flowPlace(flow, slot);
        // A line on the grid's own edge has the pane's padding beside it, not
        // a gap and a tile, so its handle stops at the padding: reaching the
        // usual 3px further made the pane scroll sideways (smoke test 87-3).
        const atBottom = lastRow === flow.rows - 1;
        const atRight = tile.x + tile.w > 1 - 1e-6;
        return (
          <Fragment key={slot}>
            {(lastRow < flow.rows - 1 || !fitRows) && (
              <Strip
                style={{
                  ...place,
                  alignSelf: "end",
                  height: REACH,
                  marginBottom: atBottom ? EDGE : PAST,
                }}
                className="cursor-row-resize"
                orientation="horizontal"
                label={lastRow < flow.rows - 1 ? rowsHint : lastHint}
                line={{ axis: "rows", index: lastRow }}
                onBegin={onBegin}
              />
            )}
            {right && (
              <Strip
                style={{
                  ...place,
                  justifySelf: "end",
                  width: REACH,
                  marginRight: atRight ? EDGE : PAST,
                }}
                className="cursor-col-resize"
                orientation="vertical"
                label={right.kind === "pair" ? pairHint : edgeHint}
                line={{ axis: "cols", line: right }}
                onBegin={onBegin}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/** How far a handle reaches into the tile on each side of the gap. */
const INSET = "3px";
/** The grid's gap (`gap-2`), and the pane's padding past the last row and the
 * last tile in a row, which are the same 0.5rem. */
const GAP = "0.5rem";
/** A handle across: the gap and a little of the tile on each side. */
const REACH = `calc(${GAP} + 2 * ${INSET})`;
/** Out of the owning tile's area, over the gap, into the next tile. */
const PAST = `calc(-1 * (${GAP} + ${INSET}))`;
/** Out of the owning tile's area into the pane's padding, and no further. */
const EDGE = `calc(-1 * ${GAP})`;

/** `data-split` carries the line, so a press in the gap beside the strip can
 * find it (see useGridSplitters' `gapProps`), which also lights it with
 * `data-near`. */
function Strip({
  style,
  className,
  orientation,
  label,
  line,
  onBegin,
}: {
  style: React.CSSProperties;
  className: string;
  orientation: "horizontal" | "vertical";
  label: string;
  line: SplitLine;
  onBegin: (e: React.MouseEvent, line: SplitLine) => void;
}) {
  return (
    <div
      onMouseDown={(e) => onBegin(e, line)}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      title={label}
      data-resize-handle=""
      data-split={JSON.stringify(line)}
      style={style}
      className={`z-20 rounded-sm hover:bg-primary/40 data-near:bg-primary/40 ${className}`}
    />
  );
}
