import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

/**
 * A status line a program keeps pinned to the bottom of the screen, and what a
 * resize does to it.
 *
 * `apt` is the one everybody meets. It sets a scroll region one row short of
 * the screen (DECSTBM, `CSI 1;N-1 r`), lets its output scroll inside that, and
 * draws its "Progress: [ 40%]" bar on the row left over. On a resize it is told
 * the new size and draws the bar again on the new bottom row. It never erases
 * the old one: it assumes the terminal kept the bottom of the screen at the
 * bottom.
 *
 * xterm keeps the top there instead. Widen a pane whose output had wrapped and
 * the reflow takes lines out from above the bar; with no scrollback to pull
 * down, the bar rides up with everything else. Make a pane taller and xterm
 * adds blank rows *under* the bar. Either way the bar is left standing in the
 * middle of the screen while apt draws its live copy at the bottom, and it
 * stays there until enough output scrolls past to cover it (prompts121:
 * closing the other tile of a two-up grid during `apt upgrade`; reproduced on
 * the release build, one resize, bar left on row 32 of 42).
 *
 * So before a refit that will change the size, the rows under the program's
 * scroll region are blanked, and then the refit happens. Nothing is left to
 * carry anywhere, and the program draws its footer where it now belongs, as it
 * was always going to.
 *
 * Only ever the rows outside a region the program set itself, only on the
 * normal screen (a full-screen program on the alternate screen repaints the
 * whole thing on a resize, and has no scrollback to lose), and only when the
 * size is actually changing. A shell with no region set, which is nearly every
 * moment of every session, takes the old path untouched.
 */

/** The region is tracked by watching the program set it, because xterm does
 * not say what it is. Mirrors xterm's own `setScrollRegion`, including what it
 * does with a missing or out-of-range bottom, so the two can never disagree
 * about which rows are outside. */
export function watchStatusFooter(term: Terminal) {
  /** Zero-based last row of the program's scroll region on the normal screen,
   * or null when the region is the whole screen. */
  let regionBottom: number | null = null;
  let disposed = false;
  // A fit waiting on the erase in front of it. Only one: a second request while
  // one waits is the same request, and the waiting fit measures the pane when
  // it runs, not when it was asked for.
  let waiting: (() => void) | null = null;

  const subs = [
    term.parser.registerCsiHandler({ final: "r" }, (params) => {
      if (term.buffer.active.type !== "normal") return false;
      const rows = term.rows;
      const first = params[0];
      const second = params[1];
      const top = (typeof first === "number" && first) || 1;
      let bottom = typeof second === "number" ? second : 0;
      if (params.length < 2 || bottom > rows || bottom === 0) bottom = rows;
      // An empty or inverted region is ignored by xterm, so it is here too.
      if (bottom > top) regionBottom = bottom === rows ? null : bottom - 1;
      // Watched, not handled: xterm still applies the region itself.
      return false;
    }),
    // A full reset (RIS) and a soft one (DECSTR) both give the screen back.
    term.parser.registerEscHandler({ final: "c" }, () => {
      regionBottom = null;
      return false;
    }),
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      regionBottom = null;
      return false;
    }),
    // xterm drops the region on every resize, and the program sets it again
    // when it hears about the new size.
    term.onResize(() => {
      regionBottom = null;
    }),
  ];

  /** The rows below the region, one-based, or none. */
  const footerRows = (): number[] => {
    if (regionBottom == null) return [];
    if (term.buffer.active.type !== "normal") return [];
    // With origin mode on, cursor addressing is relative to the region and the
    // rows under it cannot be reached. Nothing uses the two together that we
    // know of; leaving it alone is the safe answer.
    if (term.modes.originMode) return [];
    const rows: number[] = [];
    for (let r = regionBottom + 1; r < term.rows; r++) rows.push(r + 1);
    return rows;
  };

  return {
    /**
     * Run `doFit` (which calls `fit.fit()`), first blanking the program's
     * footer if the fit is going to change the size. Without a footer, or when
     * the size is staying put, it runs now; with one, it runs as soon as xterm
     * has parsed the erase, which is the next turn of its write queue.
     *
     * The erase is written into the terminal's own input, between whatever the
     * program has sent so far and whatever it sends next. It saves and restores
     * the cursor and its attributes around itself and resets the colours while
     * erasing, so the line it blanks takes no background from the bar.
     */
    fit(fit: FitAddon, doFit: () => void) {
      if (waiting) {
        waiting = doFit;
        return;
      }
      const rows = footerRows();
      const dims = rows.length > 0 ? fit.proposeDimensions() : undefined;
      if (
        !dims ||
        Number.isNaN(dims.cols) ||
        Number.isNaN(dims.rows) ||
        (dims.cols === term.cols && dims.rows === term.rows)
      ) {
        doFit();
        return;
      }
      waiting = doFit;
      const erase = rows.map((r) => `\x1b[${r};1H\x1b[2K`).join("");
      term.write(`\x1b7\x1b[0m${erase}\x1b8`, () => {
        const run = waiting;
        waiting = null;
        if (!disposed && run) run();
      });
    },
    /** Forget the region, for a reset done from out here (`term.reset()` is
     * not parsed input, so the handlers above never see it). */
    forget() {
      regionBottom = null;
    },
    dispose() {
      disposed = true;
      waiting = null;
      for (const s of subs) s.dispose();
    },
  };
}
