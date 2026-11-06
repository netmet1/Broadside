import type { TilePlacement } from "@/lib/gridShape";
import type { SplitLine } from "@/pages/terminals/useGridSplitters";

/**
 * The drag strips on a grid tile's shared edges while the tiles are unlocked.
 * Each strip moves the line it sits on: the top edge is the line above this
 * tile's first row, the bottom edge the line below its last, and the same for
 * left and right. An edge on the outside of the grid has no line and no strip.
 *
 * Above the terminal (z-20), because xterm's own scrollbar sits at z 11 and
 * would otherwise take the right edge.
 */
export function SplitHandles({
  place,
  shape,
  onBegin,
}: {
  place: TilePlacement;
  shape: { rows: number; cols: number };
  onBegin: (e: React.MouseEvent, line: SplitLine) => void;
}) {
  const lastRow = place.row + place.rowSpan - 1;
  const lastCol = place.col + place.colSpan - 1;
  const rowsHint = "Drag to move the line between these rows";
  const colsHint = "Drag to move the line between these columns";
  return (
    <>
      {place.row > 0 && (
        <Strip
          className="inset-x-0 top-0 h-1.5 cursor-row-resize"
          orientation="horizontal"
          label={rowsHint}
          onMouseDown={(e) => onBegin(e, { axis: "rows", index: place.row - 1 })}
        />
      )}
      {lastRow < shape.rows - 1 && (
        <Strip
          className="inset-x-0 bottom-0 h-1.5 cursor-row-resize"
          orientation="horizontal"
          label={rowsHint}
          onMouseDown={(e) => onBegin(e, { axis: "rows", index: lastRow })}
        />
      )}
      {place.col > 0 && (
        <Strip
          className="inset-y-0 left-0 w-1.5 cursor-col-resize"
          orientation="vertical"
          label={colsHint}
          onMouseDown={(e) => onBegin(e, { axis: "cols", index: place.col - 1 })}
        />
      )}
      {lastCol < shape.cols - 1 && (
        <Strip
          className="inset-y-0 right-0 w-1.5 cursor-col-resize"
          orientation="vertical"
          label={colsHint}
          onMouseDown={(e) => onBegin(e, { axis: "cols", index: lastCol })}
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
