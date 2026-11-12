import type { FlowLine, FlowTile } from "@/lib/gridShape";
import type { SplitLine } from "@/pages/terminals/useGridSplitters";

/**
 * The drag strips on a grid tile's edges while the tiles are unlocked. The top
 * and bottom strips move the line above or below this tile's rows (and the
 * bottom of the last row is a line too, unless the rows fit the window); the
 * left and right ones move the line beside it in its own row (see
 * useGridSplitters). The right edge of a tile with blank space beside it, or
 * alone in its row, has a strip too, which sets its width. Every other edge
 * on the outside of the grid has none.
 *
 * Above the terminal (z-20), because xterm's own scrollbar sits at z 11 and
 * would otherwise take the right edge.
 */
export function SplitHandles({
  tile,
  rows,
  left,
  right,
  fitRows,
  onBegin,
}: {
  tile: FlowTile;
  /** How many rows the grid has. */
  rows: number;
  left: FlowLine | null;
  right: FlowLine | null;
  /** Rows always fill the pane (Settings -> Grid), so the grid's bottom edge
   * is not a line. */
  fitRows: boolean;
  onBegin: (e: React.MouseEvent, line: SplitLine) => void;
}) {
  const lastRow = tile.row + tile.rowSpan - 1;
  const rowsHint = fitRows
    ? "Drag to move the line between these rows"
    : "Drag to set the height of the row above this line. The rows below move, and the grid scrolls when they do not fit";
  const bottomHint = fitRows
    ? rowsHint
    : "Drag to set this row's height. The rows below move, and the grid scrolls when they do not fit";
  const pairHint =
    "Drag to move the line between these tiles. Past the minimum width (Settings > Grid), the tile on the right moves down a row";
  const edgeHint = "Drag to set this tile's width";
  const sideHint = (line: FlowLine) =>
    line.kind === "pair" ? pairHint : edgeHint;
  return (
    <>
      {tile.row > 0 && (
        <Strip
          className="inset-x-0 top-0 h-1.5 cursor-row-resize"
          orientation="horizontal"
          label={rowsHint}
          line={{ axis: "rows", index: tile.row - 1 }}
          onBegin={onBegin}
        />
      )}
      {(lastRow < rows - 1 || !fitRows) && (
        <Strip
          className="inset-x-0 bottom-0 h-1.5 cursor-row-resize"
          orientation="horizontal"
          label={bottomHint}
          line={{ axis: "rows", index: lastRow }}
          onBegin={onBegin}
        />
      )}
      {left && (
        <Strip
          className="inset-y-0 left-0 w-1.5 cursor-col-resize"
          orientation="vertical"
          label={sideHint(left)}
          line={{ axis: "cols", line: left }}
          onBegin={onBegin}
        />
      )}
      {right && (
        <Strip
          className="inset-y-0 right-0 w-1.5 cursor-col-resize"
          orientation="vertical"
          label={sideHint(right)}
          line={{ axis: "cols", line: right }}
          onBegin={onBegin}
        />
      )}
    </>
  );
}

/** `data-split` carries the line, so a press in the gap beside the strip can
 * find it (see useGridSplitters' `gapProps`), which also lights it with
 * `data-near`. */
function Strip({
  className,
  orientation,
  label,
  line,
  onBegin,
}: {
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
      className={`absolute z-20 hover:bg-primary/40 data-near:bg-primary/40 ${className}`}
    />
  );
}
