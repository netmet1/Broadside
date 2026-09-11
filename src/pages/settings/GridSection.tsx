import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { GridFields } from "@/components/GridControls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseField, useGridFields } from "@/lib/gridFields";
import { useHint } from "@/lib/status";
import { SectionHeading } from "@/pages/settings/shared";
import {
  GRID_COLS_MAX,
  GRID_COLS_MIN,
  GRID_ITEM_COLS_MAX,
  GRID_ITEM_COLS_MIN,
  GRID_ITEM_ROWS_MAX,
  GRID_ITEM_ROWS_MIN,
  loadGridSeeds,
  resetGridSeeds,
  saveGridSeedCols,
  saveGridSeedItemCols,
  saveGridSeedItemRows,
  saveGridStrict,
} from "@/lib/gridPrefs";

/**
 * Settings -> Grid. Pins the Terminals grid layout: how many tiles sit across
 * and each tile's size in characters (columns x rows). Each field is either
 * "auto" (keep the shipped fit-to-viewport behavior) or a number. This is a
 * localStorage UI pref, applied when the Terminals page is next shown (it re-reads
 * on visible), so there is no Save button: changes persist immediately.
 *
 * The four fields themselves live in `components/GridControls`, because the
 * Templates editor offers the same four in a popover beside the preview they
 * lay out. What is only here is Strict, which is about dragging a tile in the
 * grid and so has no meaning on a preview, and the Advanced defaults.
 */
export function GridSection({ id }: { id: string }) {
  const f = useGridFields();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const hint = useHint();

  return (
    <section id={id} className="space-y-4">
      <SectionHeading
        title="Grid"
        hint="Pin the Terminals grid: how many panes tile across and each pane's size in characters. Auto keeps the default fit-to-window layout."
      />
      <p className="max-w-md text-xs text-muted-foreground">
        One terminal always fills the grid and two always split the window side
        by side (or top and bottom), both ignoring these settings, so a single
        pane and the two-pane comparison view are never shrunk by a pinned tile
        size. A pinned column count is trimmed to the number of terminals
        actually open, so six columns with three terminals up lays out three
        across the window rather than leaving half of it empty.
      </p>
      <p className="max-w-md text-xs text-muted-foreground">
        The Templates editor draws its preview from these same numbers, and
        offers the four below on the line under its canvas. There is one set of
        them: a template stores no layout of its own.
      </p>
      <div className="grid max-w-md gap-4">
        <label
          className="flex max-w-md cursor-pointer items-start gap-2 text-sm"
          {...hint(
            f.strict
              ? "Strict: the numbers below are the last word. A tile size dragged in the grid lasts until Broadside is closed and is then forgotten."
              : "Not strict: dragging a tile in the grid writes its width and height here, so the size comes back after a restart.",
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={f.strict}
            onChange={(e) => {
              f.setStrict(e.target.checked);
              saveGridStrict(e.target.checked);
            }}
          />
          <span>
            <span className="font-medium">Strict</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              On (the default), these settings are the last word: a tile size
              you drag out in the grid lasts while Broadside is running and is
              lost on the next start, and the numbers below never move. Off, a
              drag is saved here as you make it, so the grid you leave is the
              grid you come back to.
            </span>
          </span>
        </label>
        <GridFields f={f} />
        <div className="border-t border-border/50 pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={advancedOpen}
            {...hint(
              "The number each field above lands on the moment its Auto box is unchecked",
            )}
          >
            {advancedOpen ? (
              <ChevronDownIcon className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronRightIcon className="h-4 w-4 shrink-0" />
            )}
            Advanced
          </button>
          {advancedOpen && (
            <div className="mt-3 space-y-4">
              <p className="max-w-md text-xs text-muted-foreground">
                Columns across, Item width and Item height each start at one of
                these numbers the moment their own Auto box above is unchecked.
                Change them to make unchecking Auto land on your own numbers
                instead of the factory 3 columns / 80x24 (the classic terminal
                size).
              </p>
              <SeedField
                label="Columns across, default"
                unit="tiles"
                min={GRID_COLS_MIN}
                max={GRID_COLS_MAX}
                value={f.seeds.cols}
                onCommit={(v) => {
                  f.setSeeds((s) => ({ ...s, cols: v }));
                  saveGridSeedCols(v);
                }}
              />
              <SeedField
                label="Item width, default"
                unit="columns"
                min={GRID_ITEM_COLS_MIN}
                max={GRID_ITEM_COLS_MAX}
                value={f.seeds.itemCols}
                onCommit={(v) => {
                  f.setSeeds((s) => ({ ...s, itemCols: v }));
                  saveGridSeedItemCols(v);
                }}
              />
              <SeedField
                label="Item height, default"
                unit="rows"
                min={GRID_ITEM_ROWS_MIN}
                max={GRID_ITEM_ROWS_MAX}
                value={f.seeds.itemRows}
                onCommit={(v) => {
                  f.setSeeds((s) => ({ ...s, itemRows: v }));
                  saveGridSeedItemRows(v);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resetGridSeeds();
                  f.setSeeds(loadGridSeeds());
                }}
                {...hint(
                  "Reset just the three defaults above, back to 3 columns / 80x24. Does not touch Columns across, Item width or Item height themselves.",
                )}
              >
                Reset defaults
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** An Advanced field: always a pinned number (no Auto toggle), edited as free
 * text so a value mid-edit (or briefly out of range) doesn't fight the input,
 * same invalid-border treatment as GridField. */
function SeedField({
  label,
  unit,
  min,
  max,
  value,
  onCommit,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  // Adjusted during render rather than in an effect (React's documented way to
  // reset state derived from a prop): an external change (the reload listener,
  // or the Reset button) has to overwrite whatever is mid-edit here, and a
  // render-phase update converges in the same pass rather than flashing the
  // stale text for a frame first.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setText(String(value));
  }
  const invalid = parseField(text, min, max) === null;

  const onText = (t: string) => {
    setText(t);
    const parsed = parseField(t, min, max);
    if (parsed !== null) onCommit(parsed);
  };

  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-3">
        <Input
          type="number"
          inputMode="numeric"
          value={text}
          min={min}
          max={max}
          onChange={(e) => onText(e.target.value)}
          aria-label={label}
          className={`w-28 font-mono text-sm ${invalid ? "border-destructive" : ""}`}
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
        <span className="text-xs text-muted-foreground">
          {min}-{max}
        </span>
      </div>
    </div>
  );
}
