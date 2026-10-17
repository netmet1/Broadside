/**
 * Keeps a held mouse button reaching the program after the program re-sets its
 * mouse modes in the middle of the press.
 *
 * xterm (6.0.0) listens for a drag and for the release on the document, and
 * only attaches those listeners at the press. When a mouse mode is switched off
 * it takes them away; when it is switched back on it only remembers to attach
 * them at the next press. tmux does exactly that on a right-click: it opens its
 * menu on the press, then clears every mouse mode and sets them again to follow
 * the pointer over the menu. From then on neither the drag nor the release got
 * through, so the menu never highlighted and letting go on an item did nothing
 * (smoke 73 E2).
 *
 * So this watches for the case and stands in for xterm until the button comes
 * up: only while a button that xterm reported is held, only after a mouse mode
 * was switched off during that hold, and only with what xterm would have sent
 * itself. Any other press goes through xterm alone, so nothing is ever sent
 * twice.
 */

import type { IDisposable, Terminal } from "@xterm/xterm";

/** `binary` is a mouse report in the original encoding, one byte per
 *  character, for the raw-bytes write path; otherwise it is ordinary text. */
export type MouseReportSink = (data: string, binary: boolean) => void;

/** The DEC private modes that pick a mouse protocol. Switching any of them off
 *  leaves xterm with no protocol, which is what drops its listeners. */
const PROTOCOL_MODES = new Set([9, 1000, 1002, 1003]);
const SGR_MODE = 1006;

export function relayHeldMouse(
  term: Terminal,
  element: HTMLElement,
  send: MouseReportSink,
): IDisposable {
  // Which encoding the program asked for. xterm keeps its own copy privately;
  // this one follows the same sequences.
  let sgr = false;
  let held: { button: number } | null = null;
  let lost = false;
  let lastCell = "";

  const onModes = (params: (number | number[])[], on: boolean) => {
    for (const p of params) {
      if (p === SGR_MODE) sgr = on;
      if (!on && held && typeof p === "number" && PROTOCOL_MODES.has(p)) lost = true;
    }
    // Watched, not handled: xterm still applies the mode.
    return false;
  };
  const setSub = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (p) =>
    onModes(p, true),
  );
  const resetSub = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (p) =>
    onModes(p, false),
  );

  const cell = (e: MouseEvent): [number, number] | null => {
    const screen = element.querySelector(".xterm-screen");
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const col = Math.floor(((e.clientX - r.left) / r.width) * term.cols) + 1;
    const row = Math.floor(((e.clientY - r.top) / r.height) * term.rows) + 1;
    return [
      Math.min(term.cols, Math.max(1, col)),
      Math.min(term.rows, Math.max(1, row)),
    ];
  };

  const report = (e: MouseEvent, code: number, release: boolean) => {
    const pos = cell(e);
    if (!pos) return;
    const [col, row] = pos;
    const mods = (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0) | (e.ctrlKey ? 16 : 0);
    if (sgr) {
      send(`\x1b[<${code | mods};${col};${row}${release ? "m" : "M"}`, false);
      return;
    }
    // The original encoding has no room past column or row 223.
    if (col > 223 || row > 223) return;
    // It has no way to say which button came up, either: a release is 3.
    const c = (release ? 3 : code) | mods;
    send(`\x1b[M${String.fromCharCode(32 + c, 32 + col, 32 + row)}`, true);
  };

  // Capture, so this sees the press before xterm's own handler runs.
  const onDown = (e: MouseEvent) => {
    // The same test xterm makes: with no protocol, or with Shift forcing a
    // selection, it sends nothing, and there is nothing to stand in for.
    if (e.button > 2 || e.shiftKey || term.modes.mouseTrackingMode === "none") return;
    held = { button: e.button };
    lost = false;
    lastCell = "";
  };
  const onMove = (e: MouseEvent) => {
    if (!held || !lost || !e.buttons) return;
    const mode = term.modes.mouseTrackingMode;
    if (mode !== "drag" && mode !== "any") return;
    const pos = cell(e);
    const key = pos ? pos.join(",") : "";
    // One report per cell, as xterm does.
    if (!pos || key === lastCell) return;
    lastCell = key;
    report(e, 32 + held.button, false);
  };
  const onUp = (e: MouseEvent) => {
    if (!held || e.button !== held.button) return;
    const mode = term.modes.mouseTrackingMode;
    if (lost && mode !== "none" && mode !== "x10") report(e, held.button, true);
    held = null;
    lost = false;
  };
  const onBlur = () => {
    held = null;
    lost = false;
  };

  element.addEventListener("mousedown", onDown, true);
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", onUp, true);
  window.addEventListener("blur", onBlur);

  return {
    dispose() {
      setSub.dispose();
      resetSub.dispose();
      element.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("blur", onBlur);
    },
  };
}
