import type { FlowLine, FlowTile } from "@/lib/gridShape";
import type { SplitLine } from "@/pages/terminals/useGridSplitters";

/**
 * The drag strips on a grid tile's edges while the tiles are unlocked. The top
 * and bottom strips move the line between this tile's rows and the next; the
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
  onBegin,
}: {
  tile: FlowTile;
  /** How many rows the grid has. */
  rows: number;
  left: FlowLine | null;
  right: FlowLine | null;
  onBegin: (e: React.MouseEvent, line: SplitLine) => void;
}) {
  const lastRow = tile.row + tile.rowSpan - 1;
  const rowsHint = "Drag to move the line between these rows";
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
          onMouseDown={(e) => onBegin(e, { axis: "rows", index: tile.row - 1 })}
        />
      )}
      {lastRow < rows - 1 && (
        <Strip
          className="inset-x-0 bottom-0 h-1.5 cursor-row-resize"
          orientation="horizontal"
          label={rowsHint}
          onMouseDown={(e) => onBegin(e, { axis: "rows", index: lastRow })}
        />
      )}
      {left && (
        <Strip
          className="inset-y-0 left-0 w-1.5 cursor-col-resize"
          orientation="vertical"
          label={sideHint(left)}
          onMouseDown={(e) => onBegin(e, { axis: "cols", line: left })}
        />
      )}
      {right && (
        <Strip
          className="inset-y-0 right-0 w-1.5 cursor-col-resize"
          orientation="vertical"
          label={sideHint(right)}
          onMouseDown={(e) => onBegin(e, { axis: "cols", line: right })}
        />
      )}
    </>
  );
}

function Strip({
  className,
  orientation,
  label,
  onMouseDown,
}: {
  className: string;
  orientation: "horizontal" | "vertical";
  label: string;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      title={label}
      data-resize-handle=""
      className={`absolute z-20 hover:bg-primary/40 ${className}`}
    />
  );
}
