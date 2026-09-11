import { useCallback, useEffect, useState } from "react";

import {
  GRID_PREFS_EVENT,
  loadGridPrefs,
  loadGridSeeds,
  loadGridStrict,
  loadRowFill,
  type GridSeeds,
  type RowFill,
} from "@/lib/gridPrefs";

/**
 * The Grid preferences as *editable state*, apart from the controls that draw
 * them.
 *
 * `lib/gridPrefs` is the storage and `components/GridControls` is the form; this
 * is the bit in between, which two screens need and neither owns. The Templates
 * editor lays its preview out from these numbers and now offers them in a
 * popover beside it, and Settings has the same four on a page. The same
 * reasoning that put the grid arithmetic in `lib/gridShape`: a second copy would
 * eventually drift.
 */

/** A field is "auto" (no pinned value) or an in-progress string being edited. */
export type FieldState = { auto: boolean; text: string };

export function fieldState(v: number | null): FieldState {
  return v === null ? { auto: true, text: "" } : { auto: false, text: String(v) };
}

/** Parse a field's text; returns the number when it is a valid integer within
 * range, else null (invalid: shown with a red border, not persisted). */
export function parseField(
  text: string,
  min: number,
  max: number,
): number | null {
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n) || String(n) !== text.trim()) return null;
  if (n < min || n > max) return null;
  return n;
}

export type GridFieldsState = ReturnType<typeof useGridFields>;

/**
 * Every Grid preference, held as editable state and kept level with whatever
 * else writes them.
 *
 * With strict off, a drag in the Terminals grid writes the tile size, and a
 * change made in the Templates popover has to reach the Settings tab. Both
 * screens stay mounted, so nothing would otherwise re-read them and each would
 * go on showing the numbers it last typed.
 *
 * `strict` is in here although only Settings draws it: one listener keeping one
 * set of values level is simpler than two, and the field costs a string.
 */
export function useGridFields() {
  const initial = loadGridPrefs();
  const [cols, setCols] = useState(fieldState(initial.cols));
  const [itemCols, setItemCols] = useState(fieldState(initial.itemCols));
  const [itemRows, setItemRows] = useState(fieldState(initial.itemRows));
  const [strict, setStrict] = useState(loadGridStrict);
  const [rowFill, setRowFill] = useState<RowFill>(loadRowFill);
  const [seeds, setSeeds] = useState<GridSeeds>(loadGridSeeds);

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

  return {
    cols,
    setCols,
    itemCols,
    setItemCols,
    itemRows,
    setItemRows,
    strict,
    setStrict,
    rowFill,
    setRowFill,
    seeds,
    setSeeds,
    reload,
  };
}

/** The three ways to treat a last row that isn't full. The wording is the whole
 * explanation the operator gets, in the section and in the status-bar hint, so
 * each one says what it does rather than naming a strategy. */
export const ROW_FILL_CHOICES: {
  value: RowFill;
  label: string;
  hint: string;
}[] = [
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
