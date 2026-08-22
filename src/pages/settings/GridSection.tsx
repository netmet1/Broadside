import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHint } from "@/lib/status";
import { SectionHeading } from "@/pages/settings/shared";
import {
  GRID_COLS_MAX,
  GRID_COLS_MIN,
  GRID_ITEM_COLS_MAX,
  GRID_ITEM_COLS_MIN,
  GRID_ITEM_ROWS_MAX,
  GRID_ITEM_ROWS_MIN,
  GRID_PREFS_EVENT,
  loadGridPrefs,
  loadGridSeeds,
  loadGridStrict,
  loadRowFill,
  resetGridSeeds,
  saveGridCols,
  saveGridItemCols,
  saveGridItemRows,
  saveGridSeedCols,
  saveGridSeedItemCols,
  saveGridSeedItemRows,
  saveGridStrict,
  saveRowFill,
  type GridSeeds,
  type RowFill,
} from "@/lib/gridPrefs";

/**
 * Settings -> Grid. Pins the Terminals grid layout: how many tiles sit across
 * and each tile's size in characters (columns x rows). Each field is either
 * "auto" (keep the shipped fit-to-viewport behavior) or a number. This is a
 * localStorage UI pref, applied when the Terminals page is next shown (it re-reads
 * on visible), so there is no Save button: changes persist immediately.
 */
export function GridSection({ id }: { id: string }) {
  const initial = loadGridPrefs();
  const [cols, setCols] = useState(fieldState(initial.cols));
  const [itemCols, setItemCols] = useState(fieldState(initial.itemCols));
  const [itemRows, setItemRows] = useState(fieldState(initial.itemRows));
  const [strict, setStrict] = useState(loadGridStrict);
  const [rowFill, setRowFill] = useState<RowFill>(loadRowFill);
  const [seeds, setSeeds] = useState<GridSeeds>(loadGridSeeds);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const hint = useHint();

  // With strict off, a drag in the Terminals grid writes the tile size here, so
  // these fields have to follow a change this component did not make. Both
  // screens stay mounted, so nothing would otherwise re-read them and the page
  // would go on showing the old numbers, which is exactly the complaint.
  const reload = useCallback(() => {
    const p = loadGridPrefs();
    setCols(fieldState(p.cols));
    setItemCols(fieldState(p.itemCols));
    setItemRows(fieldState(p.itemRows));
    setStrict(loadGridStrict());
    setRowFill(loadRowFill());
    setSeeds(loadGridSeeds());
    // The setters are listed although React guarantees their identity is stable
    // and `[]` would behave identically. The compiler cannot know that
    // guarantee, so an empty array reads to it as a dependency list that does
    // not match what the body uses, and it gives up optimizing the whole
    // component rather than risk a stale closure. Naming them costs nothing and
    // keeps the file compilable.
  }, [setCols, setItemCols, setItemRows, setStrict, setRowFill, setSeeds]);
  useEffect(() => {
    window.addEventListener(GRID_PREFS_EVENT, reload);
    return () => window.removeEventListener(GRID_PREFS_EVENT, reload);
  }, [reload]);

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
      <div className="grid max-w-md gap-4">
        <label
          className="flex max-w-md cursor-pointer items-start gap-2 text-sm"
          {...hint(
            strict
              ? "Strict: the numbers below are the last word. A tile size dragged in the grid lasts until Broadside is closed and is then forgotten."
              : "Not strict: dragging a tile in the grid writes its width and height here, so the size comes back after a restart.",
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={strict}
            onChange={(e) => {
              setStrict(e.target.checked);
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
        <GridField
          label="Columns across"
          unit="tiles"
          hint="How many terminals sit side by side. Auto uses one column, or two on a wide window. Trimmed to the number of terminals open."
          min={GRID_COLS_MIN}
          max={GRID_COLS_MAX}
          defaultValue={seeds.cols}
          state={cols}
          setState={setCols}
          onCommit={saveGridCols}
        />
        <GridField
          label="Item width"
          unit="columns"
          hint="Each tile's width in characters. When fixed widths overflow the window the grid scrolls horizontally."
          min={GRID_ITEM_COLS_MIN}
          max={GRID_ITEM_COLS_MAX}
          defaultValue={seeds.itemCols}
          state={itemCols}
          setState={setItemCols}
          onCommit={saveGridItemCols}
        />
        <GridField
          label="Item height"
          unit="rows"
          hint="Each tile's height in character rows. Extra tiles scroll vertically."
          min={GRID_ITEM_ROWS_MIN}
          max={GRID_ITEM_ROWS_MAX}
          defaultValue={seeds.itemRows}
          state={itemRows}
          setState={setItemRows}
          onCommit={saveGridItemRows}
        />
        <div className="grid gap-1.5">
          <Label>Short last row</Label>
          <div className="flex flex-col gap-1.5">
            {ROW_FILL_CHOICES.map((choice) => (
              <label
                key={choice.value}
                className="flex cursor-pointer items-start gap-2 text-sm"
                {...hint(choice.hint)}
              >
                <input
                  type="radio"
                  name="grid-row-fill"
                  className="mt-1 accent-primary"
                  checked={rowFill === choice.value}
                  onChange={() => {
                    setRowFill(choice.value);
                    saveRowFill(choice.value);
                  }}
                />
                <span>
                  {choice.label}
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {choice.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            What fills the gap when the terminals don't divide evenly into
            columns: three tiles in two columns, for instance. A pinned Item
            width or Item height wins: a stretched tile is wider than one and a
            tall tile is taller than the other, so where you have set that
            dimension by hand the gap stays.
          </p>
        </div>
        <div className="border-t border-border/50 pt-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={advancedOpen}
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
                value={seeds.cols}
                onCommit={(v) => {
                  setSeeds((s) => ({ ...s, cols: v }));
                  saveGridSeedCols(v);
                }}
              />
              <SeedField
                label="Item width, default"
                unit="columns"
                min={GRID_ITEM_COLS_MIN}
                max={GRID_ITEM_COLS_MAX}
                value={seeds.itemCols}
                onCommit={(v) => {
                  setSeeds((s) => ({ ...s, itemCols: v }));
                  saveGridSeedItemCols(v);
                }}
              />
              <SeedField
                label="Item height, default"
                unit="rows"
                min={GRID_ITEM_ROWS_MIN}
                max={GRID_ITEM_ROWS_MAX}
                value={seeds.itemRows}
                onCommit={(v) => {
                  setSeeds((s) => ({ ...s, itemRows: v }));
                  saveGridSeedItemRows(v);
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resetGridSeeds();
                  setSeeds(loadGridSeeds());
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

/** The three ways to treat a last row that isn't full. The wording is the
 * whole explanation the operator gets, in the section and in the status-bar
 * hint, so each one says what it does rather than naming a strategy. */
const ROW_FILL_CHOICES: { value: RowFill; label: string; hint: string }[] = [
  {
    value: "stretch",
    label: "Stretch the row",
    hint: "The tiles on the short row widen to fill the whole width. Three in two columns gives two on top, one wide underneath.",
  },
  {
    value: "tall",
    label: "Tall tile in the last column",
    hint: "When one space is left, the tile above grows down into it. Three in two columns gives a full-height tile on the right.",
  },
  {
    value: "gaps",
    label: "Leave the gap",
    hint: "Every tile keeps the same shape and the empty cell stays empty.",
  },
];

/** A field is "auto" (no pinned value) or an in-progress string being edited. */
type FieldState = { auto: boolean; text: string };

function fieldState(v: number | null): FieldState {
  return v === null ? { auto: true, text: "" } : { auto: false, text: String(v) };
}

/** Parse a field's text; returns the number when it is a valid integer within
 * range, else null (invalid: shown with a red border, not persisted). */
function parseField(text: string, min: number, max: number): number | null {
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || String(n) !== text.trim()) return null;
  if (n < min || n > max) return null;
  return n;
}

function GridField({
  label,
  unit,
  hint,
  min,
  max,
  defaultValue,
  state,
  setState,
  onCommit,
}: {
  label: string;
  unit: string;
  hint: string;
  min: number;
  max: number;
  defaultValue: number;
  state: FieldState;
  setState: (s: FieldState) => void;
  /** Persist the field: a number pins it, null clears it back to auto. */
  onCommit: (v: number | null) => void;
}) {
  const invalid = !state.auto && parseField(state.text, min, max) === null;

  const toggleAuto = (auto: boolean) => {
    if (auto) {
      setState({ auto: true, text: "" });
      onCommit(null);
    } else {
      setState({ auto: false, text: String(defaultValue) });
      onCommit(defaultValue);
    }
  };

  const onText = (text: string) => {
    setState({ auto: false, text });
    const parsed = parseField(text, min, max);
    if (parsed !== null) onCommit(parsed);
  };

  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary"
            checked={state.auto}
            onChange={(e) => toggleAuto(e.target.checked)}
          />
          Auto
        </label>
        <Input
          type="number"
          inputMode="numeric"
          value={state.text}
          min={min}
          max={max}
          disabled={state.auto}
          onChange={(e) => onText(e.target.value)}
          aria-label={label}
          className={`w-28 font-mono text-sm ${invalid ? "border-destructive" : ""}`}
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {hint} {min}-{max}.
      </p>
    </div>
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
