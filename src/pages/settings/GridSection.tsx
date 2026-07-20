import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionHeading } from "@/pages/settings/shared";
import {
  GRID_COLS_MAX,
  GRID_COLS_MIN,
  GRID_ITEM_COLS_MAX,
  GRID_ITEM_COLS_MIN,
  GRID_ITEM_ROWS_MAX,
  GRID_ITEM_ROWS_MIN,
  loadGridPrefs,
  saveGridCols,
  saveGridItemCols,
  saveGridItemRows,
} from "@/lib/gridPrefs";

/** Sensible starting values when a field is switched off "auto". */
const DEFAULT_COLS = 3;
const DEFAULT_ITEM_COLS = 80;
const DEFAULT_ITEM_ROWS = 24;

/**
 * Settings -> Grid. Pins the Terminals grid layout: how many tiles sit across
 * and each tile's size in characters (columns x rows). Each field is either
 * "auto" (keep the shipped fit-to-viewport behavior) or a number. This is a
 * localStorage UI pref, applied when the Terminals page is next shown (it re-reads
 * on visible), so there is no Save button — changes persist immediately.
 */
export function GridSection({ id }: { id: string }) {
  const initial = loadGridPrefs();
  const [cols, setCols] = useState(fieldState(initial.cols));
  const [itemCols, setItemCols] = useState(fieldState(initial.itemCols));
  const [itemRows, setItemRows] = useState(fieldState(initial.itemRows));

  return (
    <section id={id} className="space-y-4">
      <SectionHeading
        title="Grid"
        hint="Pin the Terminals grid: how many panes tile across and each pane's size in characters. Auto keeps the default fit-to-window layout."
      />
      <div className="grid max-w-md gap-4">
        <GridField
          label="Columns across"
          unit="tiles"
          hint="How many terminals sit side by side. Auto uses one column, or two on a wide window."
          min={GRID_COLS_MIN}
          max={GRID_COLS_MAX}
          defaultValue={DEFAULT_COLS}
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
          defaultValue={DEFAULT_ITEM_COLS}
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
          defaultValue={DEFAULT_ITEM_ROWS}
          state={itemRows}
          setState={setItemRows}
          onCommit={saveGridItemRows}
        />
      </div>
    </section>
  );
}

/** A field is "auto" (no pinned value) or an in-progress string being edited. */
type FieldState = { auto: boolean; text: string };

function fieldState(v: number | null): FieldState {
  return v === null ? { auto: true, text: "" } : { auto: false, text: String(v) };
}

/** Parse a field's text; returns the number when it is a valid integer within
 * range, else null (invalid — shown with a red border, not persisted). */
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
