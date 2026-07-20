/** Measure the pixel size of a single terminal character cell for a given font,
 * so the Grid layout can translate character-based tile sizes (cols x rows) into
 * pixels. All open terminals share one global font (the Appearance settings), so
 * one measurement serves the whole grid.
 *
 * This is a self-contained DOM measurement (a hidden monospace span), not a read
 * of xterm's internals: it is deterministic, needs no mounted terminal, and
 * matches xterm's own char measurement within a fraction of a pixel — well
 * inside the plan's "lands within ~1 col/row" tolerance (fit rounds container
 * pixels to whole cells anyway). */

export type CellMetrics = { cellW: number; cellH: number };

/** Chars measured in one go, then divided, for sub-pixel width accuracy. */
const SAMPLE = 32;

const cache = new Map<string, CellMetrics>();

/** A safe fallback if measurement ever yields a degenerate value (e.g. called
 * before fonts load): roughly a 13px monospace cell. */
const FALLBACK: CellMetrics = { cellW: 8, cellH: 17 };

export function measureTerminalCell(
  fontFamily: string,
  fontSize: number,
): CellMetrics {
  const key = `${fontFamily}|${fontSize}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result = FALLBACK;
  try {
    const span = document.createElement("span");
    // Match how xterm sizes a cell: natural line box, no wrapping, the terminal
    // font at its px size. "pre" keeps the repeated glyphs on one line.
    Object.assign(span.style, {
      position: "absolute",
      top: "-9999px",
      left: "-9999px",
      visibility: "hidden",
      whiteSpace: "pre",
      fontFamily,
      fontSize: `${fontSize}px`,
      lineHeight: "normal",
      padding: "0",
      margin: "0",
      border: "0",
    } satisfies Partial<CSSStyleDeclaration>);
    span.textContent = "W".repeat(SAMPLE);
    document.body.appendChild(span);
    const rect = span.getBoundingClientRect();
    document.body.removeChild(span);
    if (rect.width > 0 && rect.height > 0) {
      result = { cellW: rect.width / SAMPLE, cellH: rect.height };
    }
  } catch {
    // Non-browser / detached document — keep the fallback.
  }

  cache.set(key, result);
  return result;
}
