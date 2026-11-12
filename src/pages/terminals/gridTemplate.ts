/**
 * The grid on the Terminals tab, read back as a template: what the Save as
 * template button would hand the Templates tab, and whether a saved template
 * already says exactly that.
 *
 * "The grid matches a template" means the same sessions in the same order: the
 * tiles left to right, top to bottom, which is the tab strip's order. The
 * sizes the grid's lines were dragged to are compared separately, so a grid
 * that is a saved template with new sizes offers to save the sizes to it
 * rather than to make a second template.
 */

import type { GridSizes } from "@/lib/gridShape";
import type {
  Template,
  TemplateItem,
  TemplateLayout,
} from "@/lib/tauri/templates";
import type { TermSession } from "@/pages/terminals/session";

/** The template item that would open this tab again, or null for one a
 * template cannot hold. A serial console is the one: it names a port on this
 * machine at a line speed, and the Templates editor has nothing to offer it
 * from. */
export function sessionTemplateItem(s: TermSession): TemplateItem | null {
  if (s.type === "ssh") {
    return {
      kind: "host",
      hostId: s.host.id,
      ref: {
        label: s.host.label,
        hostname: s.host.hostname,
        port: s.host.port,
        username: s.host.username,
      },
    };
  }
  if (s.shell.kind === "serial") return null;
  if (s.profileId) {
    return {
      kind: "profile",
      profileId: s.profileId,
      label: s.profileLabel ?? "",
    };
  }
  return { kind: "shell", shellId: s.shell.id, label: s.shell.label };
}

/** What makes two items the same session. A host by its row when it has one,
 * by its endpoint when it is a placeholder (which no open tab can be). Labels
 * are left out: a renamed host is still the same host. */
function itemKey(item: TemplateItem): string {
  switch (item.kind) {
    case "host":
      return item.hostId != null
        ? `h:${item.hostId}`
        : `r:${item.ref.username}@${item.ref.hostname}:${item.ref.port}`;
    case "shell":
      return `s:${item.shellId}`;
    case "profile":
      return `p:${item.profileId}`;
  }
}

/** The saved template that is exactly these items, in this order, if any. */
export function matchingTemplate(
  items: TemplateItem[],
  templates: Template[],
): Template | null {
  const key = items.map(itemKey).join("|");
  return templates.find((t) => t.items.map(itemKey).join("|") === key) ?? null;
}

/** The tile widths a saved layout gives `count` sessions, in order: a fraction
 * of the grid's width, or null for a tile that shares its row.
 *
 * A layout saved before tiles had widths of their own has two column sizes
 * instead. Those become the widths of the tiles in full rows of two, which is
 * where that grid drew its column line; a short last row shares. */
export function layoutWidths(
  layout: TemplateLayout | null | undefined,
  count: number,
): (number | null)[] {
  const none = Array.from({ length: count }, () => null);
  if (!layout) return none;
  if (layout.widths && layout.widths.length > 0) {
    return none.map((_, i) => {
      const w = layout.widths?.[i] ?? 0;
      return w > 0 ? w : null;
    });
  }
  const cols = layout.cols ?? [];
  const sum = cols.reduce((a, b) => a + b, 0);
  if (cols.length !== 2 || !(sum > 0) || Math.abs(cols[0]! - cols[1]!) < 0.01) {
    return none;
  }
  const full = count === 2 ? 2 : Math.floor(count / 2) * 2;
  return none.map((_, i) => (i < full ? cols[i % 2]! / sum : null));
}

/** A saved layout as a workspace keeps it, for the tabs it opened (`ids`, in
 * the layout's order). `exact` false means some of the layout's sessions did
 * not open, so its widths no longer line up with the tabs and only its row
 * heights are kept. */
export function sizesFromLayout(
  layout: TemplateLayout | null | undefined,
  ids: string[],
  exact: boolean,
): GridSizes | null {
  if (!layout) return null;
  const widths: Record<string, number> = {};
  if (exact) {
    layoutWidths(layout, ids.length).forEach((w, i) => {
      if (w != null) widths[ids[i]!] = w;
    });
  }
  const heights = layout.heights ?? [];
  return heights.length > 0
    ? { heights, widths }
    : { heights: [], widths, rows: layout.rows ?? [] };
}

/** A workspace's sizes as a template or snapshot saves them, for its tiles in
 * order (`ids`): a width per tile, 0 for one that shares its row, and the row
 * heights in lines. Null when there is nothing but an even split to save. */
export function layoutFromSizes(
  sizes: GridSizes | null | undefined,
  ids: string[],
): TemplateLayout | null {
  if (!sizes) return null;
  const widths = ids.map((id) => sizes.widths[id] ?? 0);
  const rows = sizes.heights.length > 0 ? [] : (sizes.rows ?? []);
  if (
    sizes.heights.length === 0 &&
    rows.length === 0 &&
    widths.every((w) => w === 0)
  ) {
    return null;
  }
  return { rows, cols: [], widths, heights: sizes.heights };
}

/** `layout` with new widths for some of its `count` sessions (null: shares its
 * row), as the Templates editor's preview is dragged. */
export function layoutWithWidths(
  layout: TemplateLayout | null,
  count: number,
  changes: Map<number, number | null>,
): TemplateLayout {
  const widths = layoutWidths(layout, count).map((w) => w ?? 0);
  for (const [i, w] of changes) {
    if (i >= 0 && i < count) widths[i] = w ?? 0;
  }
  return {
    rows: layout?.rows ?? [],
    cols: [],
    widths,
    heights: layout?.heights ?? [],
  };
}

/** `layout` with every row's height in lines, as the editor's preview is
 * dragged. Relative heights from an older layout are replaced. */
export function layoutWithHeights(
  layout: TemplateLayout | null,
  count: number,
  heights: number[],
): TemplateLayout {
  return {
    rows: [],
    cols: [],
    widths: layoutWidths(layout, count).map((w) => w ?? 0),
    heights,
  };
}

/** `layout` after the editor's sessions changed: `edit` does to the widths
 * what was done to the sessions, so each width stays with its session. */
export function layoutAfterItems(
  layout: TemplateLayout | null,
  count: number,
  edit: (widths: number[]) => number[],
): TemplateLayout | null {
  if (!layout?.widths || layout.widths.length === 0) return layout;
  const widths = layoutWidths(layout, count).map((w) => w ?? 0);
  return { ...layout, widths: edit(widths) };
}

/** The same sizes, near enough that nobody could see the difference. Two
 * absent layouts are the same (an even split). `count` is how many sessions
 * the widths are for. */
export function sameLayout(
  a: TemplateLayout | null | undefined,
  b: TemplateLayout | null | undefined,
  count: number,
): boolean {
  if (!a || !b) return !a && !b;
  const close = (x: (number | null)[], y: (number | null)[]) =>
    x.length === y.length &&
    x.every((v, i) => Math.abs((v ?? 0) - (y[i] ?? 0)) < 0.01);
  const pad = (x: number[], y: number[], fill: number) => {
    const n = Math.max(x.length, y.length);
    return [
      Array.from({ length: n }, (_, i) => x[i] ?? fill),
      Array.from({ length: n }, (_, i) => y[i] ?? fill),
    ] as const;
  };
  const [ar, br] = pad(a.rows, b.rows, 1);
  const ah = a.heights ?? [];
  const bh = b.heights ?? [];
  const sameHeights =
    ah.length === bh.length && ah.every((v, i) => Math.abs(v - bh[i]!) < 0.1);
  return (
    close(ar, br) &&
    sameHeights &&
    close(layoutWidths(a, count), layoutWidths(b, count))
  );
}
