import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ROW_FILL_CHOICES,
  parseField,
  type FieldState,
  type GridFieldsState,
} from "@/lib/gridFields";
import {
  GRID_COLS_MAX,
  GRID_COLS_MIN,
  GRID_ITEM_COLS_MAX,
  GRID_ITEM_COLS_MIN,
  GRID_ITEM_ROWS_MAX,
  GRID_ITEM_ROWS_MIN,
  saveGridCols,
  saveGridItemCols,
  saveGridItemRows,
  saveRowFill,
} from "@/lib/gridPrefs";
import { useHint } from "@/lib/status";

/**
 * Columns across, Item width, Item height and the short-row fill, in the order
 * they are asked about.
 *
 * Pulled out of `pages/settings/GridSection` when a second screen needed them:
 * the Templates editor lays its preview out from these numbers, and walking to
 * the Settings tab to change one and back again to see what it did is the whole
 * of the friction. One component, so the two screens cannot come to offer a
 * different range, a different default or a different word for the same thing.
 *
 * **Strict is not here.** It governs what a tile size dragged out in the
 * Terminals grid means, and there is nothing to drag on a preview, so it stays
 * on the Settings page with the rest of that story. Nor are the three Advanced
 * defaults, which are about what unchecking Auto lands on and are read once a
 * year.
 *
 * `compact` is the Templates rendering: no paragraph under each field, because
 * a popover is not a page. The words are not lost, they move to the status-bar
 * hint, which is where the rest of the app explains a control you are pointing
 * at.
 */
export function GridFields({
  f,
  compact = false,
}: {
  f: GridFieldsState;
  compact?: boolean;
}) {
  const hint = useHint();
  // Radios sharing a name are one group, and both screens can be mounted at
  // once: without this the Settings radios and the Templates popover's would be
  // the same three buttons wearing two coats, fighting over which is checked
  // and letting an arrow key jump from one screen to the other.
  const rowFillGroup = useId();
  return (
    <>
      <GridField
        label="Columns across"
        hint="How many terminals sit side by side. Auto uses one column, or two on a wide window. Trimmed to the number of terminals open."
        unit="tiles"
        min={GRID_COLS_MIN}
        max={GRID_COLS_MAX}
        defaultValue={f.seeds.cols}
        state={f.cols}
        setState={f.setCols}
        onCommit={saveGridCols}
        compact={compact}
      />
      <GridField
        label="Item width"
        hint="Each tile's width in characters. When fixed widths overflow the window the grid scrolls horizontally."
        unit="columns"
        min={GRID_ITEM_COLS_MIN}
        max={GRID_ITEM_COLS_MAX}
        defaultValue={f.seeds.itemCols}
        state={f.itemCols}
        setState={f.setItemCols}
        onCommit={saveGridItemCols}
        compact={compact}
      />
      <GridField
        label="Item height"
        hint="Each tile's height in character rows. Extra tiles scroll vertically."
        unit="rows"
        min={GRID_ITEM_ROWS_MIN}
        max={GRID_ITEM_ROWS_MAX}
        defaultValue={f.seeds.itemRows}
        state={f.itemRows}
        setState={f.setItemRows}
        onCommit={saveGridItemRows}
        compact={compact}
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
                name={rowFillGroup}
                className={
                  compact ? "mt-0.5 accent-primary" : "mt-1 accent-primary"
                }
                checked={f.rowFill === choice.value}
                onChange={() => {
                  f.setRowFill(choice.value);
                  saveRowFill(choice.value);
                }}
              />
              <span>
                {choice.label}
                {!compact && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {choice.hint}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
        {!compact && (
          <p className="text-xs text-muted-foreground">
            What fills the gap when the terminals don't divide evenly into
            columns: three tiles in two columns, for instance. A pinned Item
            width or Item height wins: a stretched tile is wider than one and a
            tall tile is taller than the other, so where you have set that
            dimension by hand the gap stays.
          </p>
        )}
      </div>
    </>
  );
}

function GridField({
  label,
  unit,
  hint: hintText,
  min,
  max,
  defaultValue,
  state,
  setState,
  onCommit,
  compact,
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
  compact: boolean;
}) {
  const hint = useHint();
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
    <div className="grid gap-1.5" {...hint(`${hintText} ${min}-${max}.`)}>
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
          className={`${compact ? "w-20" : "w-28"} font-mono text-sm ${
            invalid ? "border-destructive" : ""
          }`}
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          {hintText} {min}-{max}.
        </p>
      )}
    </div>
  );
}
